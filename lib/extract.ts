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
  extractionModel,
  MAX_OUTPUT_TOKENS,
  resolveAnthropicClientOptions,
} from "@/lib/config";
import { ModelOutputSchema, CONFIDENCE_FIELDS, type ExtractionResult } from "@/lib/schema";
import { buildResult } from "@/lib/review";

/**
 * Thrown when no extraction provider is configured — the caller turns this into
 * a friendly 503. Production expects `ANTHROPIC_API_KEY`; the eval path can also
 * route the same native SDK through OpenRouter with `OPENROUTER_API_KEY`.
 */
export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "No extraction provider configured (set ANTHROPIC_API_KEY, or OPENROUTER_API_KEY to route the native SDK through OpenRouter)",
    );
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

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  // Provider-agnostic construction: `{}` for native Anthropic (the SDK reads
  // ANTHROPIC_API_KEY itself), or base URL + Bearer authToken for OpenRouter's
  // Anthropic Skin. Either way it's the SAME native @anthropic-ai/sdk and the
  // SAME messages.create + strict-tool-use path below. See lib/config.ts.
  const options = resolveAnthropicClientOptions();
  if (!options) throw new MissingApiKeyError();
  if (!cachedClient) cachedClient = new Anthropic(options);
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
 * Call the model and return the validated structured output plus the derived
 * review signals. Throws MissingApiKeyError if no key is configured, and lets
 * the SDK's typed errors (rate limit, etc.) propagate to the caller.
 */
export async function extractInvoice(
  bytes: Buffer,
  media: SupportedMedia,
): Promise<ExtractionResult> {
  const client = getClient();
  const base64 = bytes.toString("base64");

  // Prompt caching intentionally NOT applied. Caching is a prefix match with a
  // per-model minimum cacheable prefix; on Haiku 4.5 that minimum is 4096 tokens.
  // Our entire static prefix (system prompt + the record_invoice tool schema) is
  // ~600–730 tokens, well under that floor, so a `cache_control` breakpoint would
  // silently no-op (cache_creation_input_tokens: 0) — cost noise, not savings.
  // The volatile part (the document bytes) is per-request and can't be cached.
  // If the static prefix ever grows past ~4K tokens, add cache_control to the
  // last tool definition (tools render before system, so it covers both).
  const response = await client.messages.create({
    model: extractionModel(),
    max_tokens: MAX_OUTPUT_TOKENS,
    system: SYSTEM_PROMPT,
    tools: [
      {
        name: TOOL_NAME,
        description: "Record the structured contents of one invoice or receipt.",
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
          {
            type: "text",
            text: "Extract this document into the record_invoice tool.",
          },
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

  // Enforced by strict:true, but we re-validate so a bad response fails loudly
  // here rather than corrupting the UI downstream.
  const { invoice, fieldConfidence } = ModelOutputSchema.parse(toolUse.input);

  return buildResult(invoice, fieldConfidence);
}
