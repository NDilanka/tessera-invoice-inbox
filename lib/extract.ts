// Extraction core: PDF or image bytes -> structured invoice JSON with per-field
// confidence. Uses the NATIVE Anthropic SDK and tool-use (structured output) so
// the response SHAPE is enforced by the API, not by hopeful JSON.parse().
//
// Two independent confidence signals are combined per field:
//   1. The model's own high/medium/low self-assessment (asked for in the tool).
//   2. Deterministic validation computed here in code (arithmetic checks, date
//      parseability). These can't be gamed by a confident-but-wrong model.
// Each field's displayed status is the WORST of the two.

import Anthropic from "@anthropic-ai/sdk";
import {
  MAX_OUTPUT_TOKENS,
  resolveExtractionProvider,
  type ExtractionProvider,
} from "@/lib/config";
import { ModelOutputSchema, CONFIDENCE_FIELDS, type ExtractionResult } from "@/lib/schema";
import { buildResult } from "@/lib/review";

/**
 * Thrown when no extraction provider is configured — the caller turns this into
 * a friendly 503. Production expects ANTHROPIC_API_KEY; the eval/fallback path
 * (see DECISIONS.md) also accepts OPENROUTER_API_KEY.
 */
export class MissingApiKeyError extends Error {
  constructor() {
    super("No extraction provider configured (set ANTHROPIC_API_KEY, or OPENROUTER_API_KEY for the eval fallback)");
    this.name = "MissingApiKeyError";
  }
}

/**
 * Thrown when the model's response is truncated (stop_reason === "max_tokens")
 * before the tool call completes — the caller turns this into a friendly 422
 * instead of a generic 500 / zod parse throw.
 */
export class OutputLimitError extends Error {
  constructor() {
    super("Extraction hit the output token limit before completing.");
    this.name = "OutputLimitError";
  }
}

export type SupportedMedia =
  | "application/pdf"
  | "image/jpeg"
  | "image/png";

const TOOL_NAME = "record_invoice";

// JSON Schema handed to the tool. `strict: true` guarantees the model's output
// validates exactly against this shape. Optional/absent fields are modelled as
// nullable-and-required so strict mode is satisfied while still letting the model
// signal "not present on this document" with an explicit null.
const nullableNumber = { anyOf: [{ type: "number" }, { type: "null" }] } as const;
const confidenceEnum = {
  type: "string",
  enum: ["high", "medium", "low"],
} as const;

const INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["invoice", "fieldConfidence"],
  properties: {
    invoice: {
      type: "object",
      additionalProperties: false,
      required: [
        "vendor",
        "documentNumber",
        "issueDate",
        "dueDate",
        "currency",
        "subtotal",
        "tax",
        "total",
        "lineItems",
      ],
      properties: {
        vendor: { type: "string", description: "Seller / vendor name." },
        documentNumber: {
          type: "string",
          description: "Invoice or receipt number/id.",
        },
        issueDate: {
          type: "string",
          description: "Issue date, normalized to ISO 8601 (YYYY-MM-DD) if possible.",
        },
        dueDate: {
          anyOf: [{ type: "string" }, { type: "null" }],
          description: "Payment due date (ISO 8601) or null if not present.",
        },
        currency: {
          type: "string",
          description: "ISO 4217 currency code (e.g. USD, EUR) or the symbol if unknown.",
        },
        subtotal: { ...nullableNumber, description: "Pre-tax subtotal, or null." },
        tax: { ...nullableNumber, description: "Tax amount, or null." },
        total: { type: "number", description: "Grand total actually due/paid." },
        lineItems: {
          type: "array",
          description: "One entry per line item.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["description", "qty", "unitPrice", "amount"],
            properties: {
              description: { type: "string" },
              qty: { ...nullableNumber, description: "Quantity, or null." },
              unitPrice: { ...nullableNumber, description: "Unit price, or null." },
              amount: { type: "number", description: "Line total for this item." },
            },
          },
        },
      },
    },
    fieldConfidence: {
      type: "object",
      additionalProperties: false,
      required: [...CONFIDENCE_FIELDS],
      properties: Object.fromEntries(
        CONFIDENCE_FIELDS.map((f) => [f, confidenceEnum]),
      ),
      description:
        "Your confidence for each top-level field: 'high' when the value is clearly legible, 'medium' when inferred, 'low' when guessed or the field was hard to read.",
    },
  },
} as const;

const SYSTEM_PROMPT =
  "You are a precise document-extraction engine for invoices and receipts. " +
  "Read the attached document and record its fields using the record_invoice tool. " +
  "Transcribe values exactly as printed; do not invent data. Normalize dates to " +
  "ISO 8601 (YYYY-MM-DD) when you can read them. For any field that is genuinely " +
  "absent from the document, use null (never a made-up value). Report an honest " +
  "per-field confidence.";

const TOOL_DESCRIPTION =
  "Record the structured contents of one invoice or receipt.";
const USER_INSTRUCTION = "Extract this document into the record_invoice tool.";

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  // The client reads ANTHROPIC_API_KEY from the environment. Provider
  // resolution has already confirmed the key is present when we get here.
  if (!cachedClient) cachedClient = new Anthropic();
  return cachedClient;
}

function documentBlock(
  base64: string,
  media: SupportedMedia,
): Anthropic.ContentBlockParam {
  if (media === "application/pdf") {
    return {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: base64 },
    };
  }
  return {
    type: "image",
    source: { type: "base64", media_type: media, data: base64 },
  };
}

/**
 * Production path: the NATIVE Anthropic API with tool-use (strict schema).
 * Returns the raw tool-call input for the caller to validate.
 */
async function callAnthropic(
  provider: Extract<ExtractionProvider, { kind: "anthropic" }>,
  base64: string,
  media: SupportedMedia,
): Promise<unknown> {
  const client = getClient();

  const response = await client.messages.create({
    model: provider.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: SYSTEM_PROMPT,
    tools: [
      {
        name: TOOL_NAME,
        description: TOOL_DESCRIPTION,
        // strict: true makes the API enforce INPUT_SCHEMA exactly.
        strict: true,
        input_schema: INPUT_SCHEMA as unknown as Anthropic.Tool.InputSchema,
      },
    ],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [
      {
        role: "user",
        content: [
          documentBlock(base64, media),
          { type: "text", text: USER_INSTRUCTION },
        ],
      },
    ],
  });

  // Truncated before the tool call finished — the JSON is incomplete, so
  // parsing it would throw. Surface a structured error the route maps to 422.
  if (response.stop_reason === "max_tokens") {
    throw new OutputLimitError();
  }

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (!toolUse) {
    throw new Error("Model did not return a tool call for extraction.");
  }
  return toolUse.input;
}

// Minimal shape of the OpenAI-compatible chat-completions response we read.
interface OpenAIChatResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
    };
  }>;
}

/**
 * EVAL / FALLBACK path (see DECISIONS.md): the SAME model served by OpenRouter
 * via its OpenAI-compatible `/chat/completions` route. OpenRouter documents no
 * Anthropic-native endpoint, so we map the existing strict tool schema into the
 * OpenAI `tools` (function) format — the mapping is pass-through because that
 * format accepts JSON Schema, so the anyOf-nullable semantics are preserved.
 *
 * Image extraction only: the eval is image-based, and production PDFs stay on
 * the native Anthropic `document` block. Returns the raw tool-call arguments
 * for the caller to validate with the same Zod schema as production.
 */
async function callOpenRouter(
  provider: Extract<ExtractionProvider, { kind: "openrouter" }>,
  base64: string,
  media: SupportedMedia,
): Promise<unknown> {
  if (media === "application/pdf") {
    throw new Error(
      "The OpenRouter eval fallback supports image extraction only. Run PDF extraction through the native Anthropic path (set ANTHROPIC_API_KEY).",
    );
  }

  const res = await fetch(`${provider.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: USER_INSTRUCTION },
            {
              type: "image_url",
              image_url: { url: `data:${media};base64,${base64}` },
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: TOOL_NAME,
            description: TOOL_DESCRIPTION,
            // The OpenAI tools format accepts JSON Schema, so INPUT_SCHEMA
            // (incl. the anyOf-nullable pattern) passes through unchanged.
            strict: true,
            parameters: INPUT_SCHEMA,
          },
        },
      ],
      tool_choice: { type: "function", function: { name: TOOL_NAME } },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `OpenRouter extraction request failed (${res.status}): ${detail.slice(0, 300)}`,
    );
  }

  const data = (await res.json()) as OpenAIChatResponse;
  const choice = data.choices?.[0];

  // Truncated before the tool call finished — mirror the native path's 422.
  if (choice?.finish_reason === "length") {
    throw new OutputLimitError();
  }

  const args = choice?.message?.tool_calls?.[0]?.function?.arguments;
  if (!args) {
    throw new Error("OpenRouter model did not return a tool call for extraction.");
  }
  return JSON.parse(args);
}

/**
 * Call the model and return the validated structured output plus the derived
 * review signals. Uses the native Anthropic API by default, or the OpenRouter
 * fallback when only OPENROUTER_API_KEY is set (see resolveExtractionProvider).
 * Throws MissingApiKeyError if no provider is configured.
 */
export async function extractInvoice(
  bytes: Buffer,
  media: SupportedMedia,
): Promise<ExtractionResult> {
  const provider = resolveExtractionProvider();
  if (!provider) throw new MissingApiKeyError();

  const base64 = bytes.toString("base64");
  const rawInput =
    provider.kind === "openrouter"
      ? await callOpenRouter(provider, base64, media)
      : await callAnthropic(provider, base64, media);

  // Enforced by strict tool use, but we re-validate so a bad response fails
  // loudly here rather than corrupting the UI downstream.
  const { invoice, fieldConfidence } = ModelOutputSchema.parse(rawInput);

  return buildResult(invoice, fieldConfidence);
}
