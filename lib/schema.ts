// The extraction target shape, expressed once as a Zod schema and reused
// everywhere: it validates the model's tool-call output, drives the JSON Schema
// we hand to the Anthropic tool definition, and types the whole app.
import { z } from "zod";

/** A single invoice/receipt line item. qty and unitPrice are often absent on receipts. */
export const LineItemSchema = z.object({
  description: z.string(),
  qty: z.number().nullable().optional(),
  unitPrice: z.number().nullable().optional(),
  amount: z.number(),
});
export type LineItem = z.infer<typeof LineItemSchema>;

/** The structured document we extract from an invoice or receipt. */
export const InvoiceSchema = z.object({
  vendor: z.string(),
  documentNumber: z.string(),
  issueDate: z.string(),
  dueDate: z.string().nullable().optional(),
  currency: z.string(),
  subtotal: z.number().nullable().optional(),
  tax: z.number().nullable().optional(),
  total: z.number(),
  lineItems: z.array(LineItemSchema),
});
export type Invoice = z.infer<typeof InvoiceSchema>;

/** Model self-reported confidence, one of three buckets. */
export const Confidence = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof Confidence>;

/** The top-level fields the model reports a confidence for. */
export const CONFIDENCE_FIELDS = [
  "vendor",
  "documentNumber",
  "issueDate",
  "dueDate",
  "currency",
  "subtotal",
  "tax",
  "total",
] as const;
export type ConfidenceField = (typeof CONFIDENCE_FIELDS)[number];

/** Per-field confidence, as reported by the model alongside the values. */
export const FieldConfidenceSchema = z.object({
  vendor: Confidence,
  documentNumber: Confidence,
  issueDate: Confidence,
  dueDate: Confidence,
  currency: Confidence,
  subtotal: Confidence,
  tax: Confidence,
  total: Confidence,
});
export type FieldConfidence = z.infer<typeof FieldConfidenceSchema>;

/** What the model returns via the tool call: the values + its per-field confidence. */
export const ModelOutputSchema = z.object({
  invoice: InvoiceSchema,
  fieldConfidence: FieldConfidenceSchema,
});
export type ModelOutput = z.infer<typeof ModelOutputSchema>;

// --- Derived review signals (computed in lib/extract.ts) --------------------
export type ReviewStatus = "green" | "amber" | "red";

/** A deterministic validation flag derived in code, not from the model. */
export type ValidationFlag = "arithmetic_mismatch" | "format_warning";

export interface FieldMeta {
  /** Model self-reported confidence. */
  confidence: Confidence;
  /** Deterministic flags this field tripped (may be empty). */
  flags: ValidationFlag[];
  /** Worst-of the model signal and the deterministic signal. */
  status: ReviewStatus;
}

/** The full extraction result returned by the API and rendered in the UI. */
export interface ExtractionResult {
  invoice: Invoice;
  /** Per top-level field: confidence, flags, and combined status. */
  fields: Record<ConfidenceField, FieldMeta>;
  /** Document-level flags that aren't tied to a single field. */
  documentFlags: ValidationFlag[];
}
