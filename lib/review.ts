// Pure, dependency-free review logic: turns an extracted invoice + the model's
// per-field confidence into the per-field status the UI paints. No Anthropic
// SDK import here, so BOTH the server (lib/extract.ts) and the client
// (components/ResultView.tsx) can use it — the UI re-runs the deterministic
// checks live as a reviewer edits values.
import { SUM_TOLERANCE } from "@/lib/config";
import {
  CONFIDENCE_FIELDS,
  type ExtractionResult,
  type FieldMeta,
  type ReviewStatus,
  type ValidationFlag,
  type Confidence,
  type ConfidenceField,
  type Invoice,
} from "@/lib/schema";

const STATUS_RANK: Record<ReviewStatus, number> = { green: 0, amber: 1, red: 2 };

function worst(a: ReviewStatus, b: ReviewStatus): ReviewStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

function confidenceToStatus(c: Confidence): ReviewStatus {
  return c === "high" ? "green" : c === "medium" ? "amber" : "red";
}

function flagStatus(flags: ValidationFlag[]): ReviewStatus {
  if (flags.includes("arithmetic_mismatch")) return "red";
  if (flags.includes("format_warning")) return "amber";
  return "green";
}

/** A date is "OK" if it parses to a real calendar date. */
export function isParseableDate(value: string): boolean {
  const s = value.trim();
  if (!s) return false;
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (iso.test(s)) return !Number.isNaN(Date.parse(s));
  // Day-first DMY (e.g. 25/12/2019). Validate the components numerically —
  // Date.parse would (mis)read this as MDY and reject a valid day-first date.
  const dmy = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = Number(dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3]);
    return (
      day >= 1 &&
      day <= 31 &&
      month >= 1 &&
      month <= 12 &&
      year >= 1900 &&
      year <= 2100
    );
  }
  return !Number.isNaN(Date.parse(s));
}

/**
 * Combine the model's per-field confidence with deterministic validation into
 * the per-field metadata and document-level flags the UI renders. The model's
 * confidence is fixed; the deterministic flags recompute from whatever invoice
 * values are passed in (original or human-corrected).
 */
export function buildResult(
  invoice: Invoice,
  fieldConfidence: Record<ConfidenceField, Confidence>,
): ExtractionResult {
  const perFieldFlags: Record<ConfidenceField, ValidationFlag[]> = {
    vendor: [],
    documentNumber: [],
    issueDate: [],
    dueDate: [],
    currency: [],
    subtotal: [],
    tax: [],
    total: [],
  };
  const documentFlags: ValidationFlag[] = [];

  // 1. Date parseability -> format_warning on the offending date field.
  if (!isParseableDate(invoice.issueDate)) {
    perFieldFlags.issueDate.push("format_warning");
  }
  if (invoice.dueDate != null && !isParseableDate(invoice.dueDate)) {
    perFieldFlags.dueDate.push("format_warning");
  }

  // 2. Do the line items add up to the subtotal (or, absent a subtotal, the
  //    total)? A mismatch is a strong "needs review" signal on the money fields.
  const lineSum = invoice.lineItems.reduce((s, li) => s + li.amount, 0);
  const target = invoice.subtotal ?? invoice.total;
  if (invoice.lineItems.length > 0 && Math.abs(lineSum - target) > SUM_TOLERANCE) {
    documentFlags.push("arithmetic_mismatch");
    perFieldFlags.total.push("arithmetic_mismatch");
    if (invoice.subtotal != null) perFieldFlags.subtotal.push("arithmetic_mismatch");
  }

  // 3. subtotal + tax should reconcile to total when both are present.
  if (invoice.subtotal != null && invoice.tax != null) {
    if (Math.abs(invoice.subtotal + invoice.tax - invoice.total) > SUM_TOLERANCE) {
      if (!documentFlags.includes("arithmetic_mismatch")) {
        documentFlags.push("arithmetic_mismatch");
      }
      if (!perFieldFlags.total.includes("arithmetic_mismatch")) {
        perFieldFlags.total.push("arithmetic_mismatch");
      }
    }
  }

  const fields = {} as Record<ConfidenceField, FieldMeta>;
  for (const f of CONFIDENCE_FIELDS) {
    const confidence = fieldConfidence[f];
    const flags = perFieldFlags[f];
    fields[f] = {
      confidence,
      flags,
      status: worst(confidenceToStatus(confidence), flagStatus(flags)),
    };
  }

  return { invoice, fields, documentFlags };
}
