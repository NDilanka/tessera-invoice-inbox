// Central config. Kept tiny and legible so the model and its spend knobs live in
// one obvious place — mirrors the sibling docs-chat / tessera-ops-agent repos.
//
// This repo deliberately showcases the NATIVE Anthropic API (@anthropic-ai/sdk),
// where the two siblings use OpenAI-compatible routes. See DECISIONS.md.

// --- Model ------------------------------------------------------------------
/**
 * Extraction model: Anthropic's **Claude Haiku 4.5** — the cheapest currently
 * active Claude tier at **$1 / $5 per million input / output tokens** (verified
 * against the official model overview
 * https://platform.claude.com/docs/en/about-claude/models/overview and the PDF
 * support docs https://platform.claude.com/docs/en/build-with-claude/pdf-support
 * on 2026-07-10).
 *
 * Why Haiku 4.5: it is the cheapest current Claude model that supports BOTH PDF
 * document input and image/vision input (every current Claude model has vision;
 * Haiku 4.5 also accepts the `document` content block for PDFs). Document
 * extraction is a bounded, low-reasoning task, so the fastest/cheapest capable
 * tier is the right call — swapping to a stronger model is a one-line change
 * here. The API alias `claude-haiku-4-5` resolves to the pinned snapshot
 * `claude-haiku-4-5-20251001`.
 */
export const EXTRACTION_MODEL = "claude-haiku-4-5";

/** Hard cap on output tokens for one extraction. A structured invoice fits easily. */
export const MAX_OUTPUT_TOKENS = 4096;

// --- Eval / fallback provider (OpenRouter) ----------------------------------
// Production default is the NATIVE Anthropic API (above). This block adds an
// env-gated fallback so the SROIE eval can run against the user's funded
// OpenRouter account when no ANTHROPIC_API_KEY is present — serving the SAME
// model. See DECISIONS.md.
//
// OpenRouter's docs (https://openrouter.ai/docs) expose only an OpenAI-style
// `/api/v1/chat/completions` route; there is NO Anthropic-native `/v1/messages`
// endpoint we could reach by pointing @anthropic-ai/sdk at a custom baseURL. So
// the fallback is implemented against this OpenAI-compatible route in
// lib/extract.ts (image extraction only — the eval is image-based).
/** OpenRouter's OpenAI-compatible API root. */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/**
 * The same model as production, addressed the OpenRouter way. Anthropic's own
 * alias is `claude-haiku-4-5`; OpenRouter routes the identical model as
 * `anthropic/claude-haiku-4.5`.
 */
export const OPENROUTER_MODEL = "anthropic/claude-haiku-4.5";

/** Which backend serves an extraction, resolved from the environment. */
export type ExtractionProvider =
  | { kind: "anthropic"; model: string }
  | { kind: "openrouter"; apiKey: string; baseURL: string; model: string };

/**
 * Pick the extraction provider from environment variables only:
 *   - `ANTHROPIC_API_KEY` set   → direct Anthropic (production default).
 *   - else `OPENROUTER_API_KEY` → OpenRouter serving the same model (eval fallback).
 *   - else                      → `null` (caller raises a missing-key error).
 *
 * Anthropic always wins when both are set, so production behaviour is unchanged
 * — the fallback only ever engages when ANTHROPIC_API_KEY is absent.
 */
export function resolveExtractionProvider(): ExtractionProvider | null {
  if (process.env.ANTHROPIC_API_KEY) {
    return { kind: "anthropic", model: EXTRACTION_MODEL };
  }
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (openrouterKey) {
    return {
      kind: "openrouter",
      apiKey: openrouterKey,
      baseURL: OPENROUTER_BASE_URL,
      model: OPENROUTER_MODEL,
    };
  }
  return null;
}

// --- Upload limits ----------------------------------------------------------
/** Max upload size. Kept well under the serverless body limit; see DECISIONS.md. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4 MB
/** Max PDF pages accepted. Receipts/invoices are short; this bounds token cost. */
export const MAX_PDF_PAGES = 5;
/** Accepted upload MIME types. */
export const ACCEPTED_MIME = [
  "application/pdf",
  "image/jpeg",
  "image/png",
] as const;

// --- Abuse guards (see lib/guards.ts) ---------------------------------------
/** Per-IP sliding window: at most this many requests per WINDOW_MS. */
export const PER_IP_LIMIT = 6;
export const WINDOW_MS = 60_000; // 1 minute
/** Global kill-switch: at most this many served requests per UTC day. */
export const DAILY_CAP = 200;

// --- Validation tolerances (deterministic confidence signals) ---------------
/**
 * Absolute currency tolerance when checking that line items sum to the
 * subtotal/total. Guards against rounding noise (a few cents) while still
 * catching a genuine arithmetic mismatch.
 */
export const SUM_TOLERANCE = 0.02;
