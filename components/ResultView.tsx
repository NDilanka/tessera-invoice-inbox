"use client";

import { useMemo, useRef, useState } from "react";
import ConfidenceBadge from "./ConfidenceBadge";
import { buildResult } from "@/lib/review";
import { invoiceToCsv, csvFilename } from "@/lib/csv";
import type {
  ExtractionResult,
  Invoice,
  LineItem,
  ConfidenceField,
  Confidence,
} from "@/lib/schema";
import styles from "./ResultView.module.css";

interface Props {
  result: ExtractionResult;
  previewUrl: string;
  media: string;
}

type HeaderField = {
  key: ConfidenceField;
  label: string;
  kind: "text" | "number";
  optional?: boolean;
};

const HEADER_FIELDS: HeaderField[] = [
  { key: "vendor", label: "Vendor", kind: "text" },
  { key: "documentNumber", label: "Document #", kind: "text" },
  { key: "issueDate", label: "Issue date", kind: "text" },
  { key: "dueDate", label: "Due date", kind: "text", optional: true },
  { key: "currency", label: "Currency", kind: "text" },
  { key: "subtotal", label: "Subtotal", kind: "number", optional: true },
  { key: "tax", label: "Tax", kind: "number", optional: true },
  { key: "total", label: "Total", kind: "number" },
];

/** Read a header field value off the invoice as a string for the input. */
function headerValue(invoice: Invoice, key: ConfidenceField): string {
  const v = invoice[key];
  return v === null || v === undefined ? "" : String(v);
}

export default function ResultView({ result, previewUrl, media }: Props) {
  // The model's per-field confidence is fixed for the life of this document;
  // capture it once. Deterministic flags recompute from edits.
  const confidences = useRef<Record<ConfidenceField, Confidence>>(
    Object.fromEntries(
      (Object.keys(result.fields) as ConfidenceField[]).map((k) => [
        k,
        result.fields[k].confidence,
      ]),
    ) as Record<ConfidenceField, Confidence>,
  );

  const [invoice, setInvoice] = useState<Invoice>(result.invoice);

  // Re-derive per-field status live as the reviewer corrects values.
  const derived = useMemo(
    () => buildResult(invoice, confidences.current),
    [invoice],
  );

  function setHeader(key: ConfidenceField, raw: string, kind: HeaderField["kind"], optional?: boolean) {
    setInvoice((prev) => {
      const next: Invoice = { ...prev };
      if (kind === "number") {
        if (raw.trim() === "") {
          (next[key] as number | null) = optional ? null : 0;
        } else {
          const n = Number(raw);
          (next[key] as number | null) = Number.isNaN(n) ? (optional ? null : 0) : n;
        }
      } else {
        (next[key] as string | null) = optional && raw.trim() === "" ? null : raw;
      }
      return next;
    });
  }

  function setLineItem(index: number, key: keyof LineItem, raw: string) {
    setInvoice((prev) => {
      const lineItems = prev.lineItems.map((li, i) => {
        if (i !== index) return li;
        const item = { ...li };
        if (key === "description") {
          item.description = raw;
        } else if (key === "amount") {
          const n = Number(raw);
          item.amount = raw.trim() === "" || Number.isNaN(n) ? 0 : n;
        } else {
          // qty / unitPrice — nullable
          const n = Number(raw);
          item[key] = raw.trim() === "" || Number.isNaN(n) ? null : n;
        }
        return item;
      });
      return { ...prev, lineItems };
    });
  }

  function addLineItem() {
    setInvoice((prev) => ({
      ...prev,
      lineItems: [...prev.lineItems, { description: "", qty: null, unitPrice: null, amount: 0 }],
    }));
  }

  function removeLineItem(index: number) {
    setInvoice((prev) => ({
      ...prev,
      lineItems: prev.lineItems.filter((_, i) => i !== index),
    }));
  }

  function exportCsv() {
    const blob = new Blob([invoiceToCsv(invoice)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = csvFilename(invoice);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const needsReview = Object.values(derived.fields).filter(
    (f) => f.status !== "green",
  ).length;

  return (
    <div className={styles.layout}>
      {/* Document preview */}
      <section className={styles.previewCol} aria-label="Document preview">
        {media === "application/pdf" ? (
          <object data={previewUrl} type="application/pdf" className={styles.preview}>
            <a href={previewUrl}>Open the PDF</a>
          </object>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewUrl} alt="Uploaded document" className={styles.preview} />
        )}
      </section>

      {/* Editable extraction */}
      <section className={styles.dataCol}>
        <div className={styles.toolbar}>
          <div className={styles.reviewNote}>
            {needsReview === 0 ? (
              <span className={styles.reviewClear}>All fields look clean</span>
            ) : (
              <span className={styles.reviewFlag}>
                {needsReview} field{needsReview === 1 ? "" : "s"} flagged for review
              </span>
            )}
          </div>
          <button type="button" className={styles.export} onClick={exportCsv}>
            Export CSV
          </button>
        </div>

        {derived.documentFlags.includes("arithmetic_mismatch") && (
          <div className={styles.docFlag}>
            Line items don&apos;t reconcile with the subtotal/total — check the amounts.
          </div>
        )}

        <table className={styles.table}>
          <tbody>
            {HEADER_FIELDS.map((f) => {
              const meta = derived.fields[f.key];
              const flagged = meta.status !== "green";
              return (
                <tr key={f.key} className={flagged ? styles.rowFlagged : ""}>
                  <th scope="row" className={styles.fieldLabel}>
                    {f.label}
                  </th>
                  <td className={styles.fieldInput}>
                    <input
                      className={styles.input}
                      type={f.kind === "number" ? "number" : "text"}
                      step={f.kind === "number" ? "0.01" : undefined}
                      value={headerValue(invoice, f.key)}
                      placeholder={f.optional ? "—" : ""}
                      onChange={(e) => setHeader(f.key, e.target.value, f.kind, f.optional)}
                    />
                  </td>
                  <td className={styles.fieldBadge}>
                    <ConfidenceBadge meta={meta} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <h3 className={styles.lineHeading}>Line items</h3>
        <table className={styles.lineTable}>
          <thead>
            <tr>
              <th>Description</th>
              <th className={styles.num}>Qty</th>
              <th className={styles.num}>Unit price</th>
              <th className={styles.num}>Amount</th>
              <th aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {invoice.lineItems.map((li, i) => (
              <tr key={i}>
                <td>
                  <input
                    className={styles.input}
                    value={li.description}
                    onChange={(e) => setLineItem(i, "description", e.target.value)}
                  />
                </td>
                <td className={styles.num}>
                  <input
                    className={`${styles.input} ${styles.numInput}`}
                    type="number"
                    step="1"
                    value={li.qty ?? ""}
                    onChange={(e) => setLineItem(i, "qty", e.target.value)}
                  />
                </td>
                <td className={styles.num}>
                  <input
                    className={`${styles.input} ${styles.numInput}`}
                    type="number"
                    step="0.01"
                    value={li.unitPrice ?? ""}
                    onChange={(e) => setLineItem(i, "unitPrice", e.target.value)}
                  />
                </td>
                <td className={styles.num}>
                  <input
                    className={`${styles.input} ${styles.numInput}`}
                    type="number"
                    step="0.01"
                    value={li.amount}
                    onChange={(e) => setLineItem(i, "amount", e.target.value)}
                  />
                </td>
                <td className={styles.num}>
                  <button
                    type="button"
                    className={styles.removeBtn}
                    onClick={() => removeLineItem(i)}
                    aria-label={`Remove line item ${i + 1}`}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className={styles.addBtn} onClick={addLineItem}>
          + Add line item
        </button>
      </section>
    </div>
  );
}
