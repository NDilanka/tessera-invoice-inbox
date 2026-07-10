// CSV export of the (possibly human-corrected) invoice. Runs on the client from
// the edited state, so what you export is exactly what's on screen.
import type { Invoice } from "@/lib/schema";

/** RFC-4180-ish escaping: wrap in quotes and double any embedded quotes. */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  // Neutralize CSV formula injection: a leading =, +, -, or @ can be
  // interpreted as a formula by Excel/Sheets. Prefix with a single quote.
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function row(cells: (string | number | null | undefined)[]): string {
  return cells.map(cell).join(",");
}

/**
 * Build a two-section CSV: a header block of document-level fields, a blank
 * line, then the line-items table. Legible in Excel/Sheets and round-trips the
 * corrected values.
 */
export function invoiceToCsv(invoice: Invoice): string {
  const lines: string[] = [];

  // Header section — one field per row.
  lines.push(row(["Field", "Value"]));
  lines.push(row(["Vendor", invoice.vendor]));
  lines.push(row(["Document Number", invoice.documentNumber]));
  lines.push(row(["Issue Date", invoice.issueDate]));
  lines.push(row(["Due Date", invoice.dueDate ?? ""]));
  lines.push(row(["Currency", invoice.currency]));
  lines.push(row(["Subtotal", invoice.subtotal ?? ""]));
  lines.push(row(["Tax", invoice.tax ?? ""]));
  lines.push(row(["Total", invoice.total]));

  // Blank separator row, then the line-items table.
  lines.push("");
  lines.push(row(["Description", "Qty", "Unit Price", "Amount"]));
  for (const li of invoice.lineItems) {
    lines.push(row([li.description, li.qty ?? "", li.unitPrice ?? "", li.amount]));
  }

  return lines.join("\r\n");
}

/** Filename-safe slug for the download, derived from vendor + document number. */
export function csvFilename(invoice: Invoice): string {
  const slug = `${invoice.vendor}-${invoice.documentNumber}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "invoice"}.csv`;
}
