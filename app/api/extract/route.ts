// POST /api/extract — multipart upload of one invoice/receipt, returns the
// structured ExtractionResult as JSON. Abuse guards run at the boundary before
// any Anthropic call; a missing API key returns a friendly 503 (never a crash).
import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { PDFDocument } from "pdf-lib";
import { runGuards } from "@/lib/guards";
import {
  extractInvoice,
  MissingApiKeyError,
  OutputLimitError,
  type SupportedMedia,
} from "@/lib/extract";
import { MAX_FILE_BYTES, MAX_PDF_PAGES, ACCEPTED_MIME } from "@/lib/config";

// Node runtime: pdf-lib and the Anthropic SDK need Node APIs (Buffer, etc.).
export const runtime = "nodejs";

function bad(status: number, error: string, message: string) {
  return NextResponse.json({ error, message }, { status });
}

/** Verify the buffer's leading bytes match the claimed MIME type. */
function magicBytesMatch(bytes: Buffer, media: string): boolean {
  if (media === "application/pdf") {
    return bytes.subarray(0, 5).toString("latin1") === "%PDF-";
  }
  if (media === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (media === "image/png") {
    return (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 && // P
      bytes[2] === 0x4e && // N
      bytes[3] === 0x47 // G
    );
  }
  return false;
}

export async function POST(req: Request) {
  // 1. Parse multipart body.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad(400, "bad_request", "Expected a multipart/form-data upload.");
  }

  const file = form.get("file");
  const turnstileToken = (form.get("turnstileToken") as string) || undefined;

  if (!(file instanceof File)) {
    return bad(400, "no_file", "No file was uploaded.");
  }

  // 2. Validate type and size BEFORE spending any guard budget or API call.
  const media = file.type as string;
  if (!ACCEPTED_MIME.includes(media as (typeof ACCEPTED_MIME)[number])) {
    return bad(
      415,
      "unsupported_type",
      "Only PDF, JPG, and PNG files are supported.",
    );
  }
  if (file.size === 0) {
    return bad(400, "empty_file", "The uploaded file is empty.");
  }
  if (file.size > MAX_FILE_BYTES) {
    return bad(
      413,
      "too_large",
      `File is too large. The limit is ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB.`,
    );
  }

  // 3. Abuse guards (Turnstile, then per-IP + daily). Run before any buffering
  //    or PDF parsing so blocked requests never spend that work, the API, or the
  //    daily counter.
  const verdict = await runGuards(req, turnstileToken);
  if (!verdict.ok) return bad(verdict.status, verdict.error, verdict.message);

  // 4. Buffer the upload, then verify the magic bytes match the claimed type
  //    (a text file renamed .png must not reach pdf-lib or the model).
  const bytes = Buffer.from(await file.arrayBuffer());
  if (!magicBytesMatch(bytes, media)) {
    return bad(
      415,
      "unsupported_type",
      "Only PDF, JPG, and PNG files are supported.",
    );
  }

  // 5. PDFs: enforce the page cap so we can't be handed a 500-page document.
  if (media === "application/pdf") {
    try {
      const doc = await PDFDocument.load(bytes, { updateMetadata: false });
      const pages = doc.getPageCount();
      if (pages > MAX_PDF_PAGES) {
        return bad(
          422,
          "too_many_pages",
          `PDF has ${pages} pages; the limit is ${MAX_PDF_PAGES}.`,
        );
      }
    } catch {
      return bad(422, "bad_pdf", "That PDF could not be read.");
    }
  }

  // 6. Extract.
  try {
    const result = await extractInvoice(bytes, media as SupportedMedia);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      return bad(
        503,
        "no_api_key",
        "The extraction service isn't configured yet (set ANTHROPIC_API_KEY, or OPENROUTER_API_KEY for the OpenRouter route).",
      );
    }
    if (err instanceof OutputLimitError) {
      return bad(
        422,
        "output_limit",
        "This document is too complex for the demo (output limit reached). Try a shorter document.",
      );
    }
    if (err instanceof Anthropic.RateLimitError) {
      return bad(429, "upstream_rate_limit", "The model is busy. Try again shortly.");
    }
    if (err instanceof Anthropic.APIError) {
      return bad(502, "upstream_error", "The extraction service returned an error.");
    }
    console.error("extract failed:", err);
    return bad(500, "internal_error", "Something went wrong extracting that document.");
  }
}
