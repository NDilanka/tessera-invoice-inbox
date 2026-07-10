/**
 * Generates the three preloaded sample documents into public/samples/.
 * Two clean invoice PDFs (pdf-lib) and one receipt PNG (canvas) so the demo
 * exercises both the PDF document path and the image/vision path.
 *
 * All vendors are invented ("Tessera-fictional") — they bill the fictional
 * Tessera SaaS. Run with:  npm run gen:samples
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "samples");

interface Line {
  description: string;
  qty?: number;
  unitPrice?: number;
  amount: number;
}
interface InvoiceSpec {
  vendor: string;
  vendorLine2: string;
  number: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  symbol: string;
  billTo: string[];
  lines: Line[];
  subtotal: number;
  taxLabel: string;
  tax: number;
  total: number;
}

const money = (n: number) => n.toFixed(2);

const INK = rgb(0.1, 0.12, 0.17);
const SOFT = rgb(0.42, 0.46, 0.52);
const ACCENT = rgb(0.12, 0.44, 0.92);
const LINE = rgb(0.86, 0.88, 0.91);

function drawInvoicePdf(spec: InvoiceSpec, doc: PDFDocument, font: PDFFont, bold: PDFFont) {
  const page: PDFPage = doc.addPage([595, 842]); // A4
  const { width, height } = page.getSize();
  const M = 48;
  let y = height - M;

  const text = (
    s: string,
    x: number,
    yy: number,
    size = 10,
    f = font,
    color = INK,
  ) => page.drawText(s, { x, y: yy, size, font: f, color });

  const right = (s: string, xRight: number, yy: number, size = 10, f = font, color = INK) => {
    const w = f.widthOfTextAtSize(s, size);
    text(s, xRight - w, yy, size, f, color);
  };

  // Header
  text(spec.vendor, M, y, 18, bold);
  right("INVOICE", width - M, y, 20, bold, ACCENT);
  y -= 16;
  text(spec.vendorLine2, M, y, 9, font, SOFT);
  y -= 34;

  // Meta block (right) + bill-to (left)
  const metaX = width - M;
  right(`Invoice #  ${spec.number}`, metaX, y, 10, font);
  text("BILL TO", M, y, 9, bold, SOFT);
  y -= 14;
  right(`Issued  ${spec.issueDate}`, metaX, y, 10, font);
  text(spec.billTo[0] ?? "", M, y, 10, bold);
  y -= 14;
  right(`Due  ${spec.dueDate}`, metaX, y, 10, font);
  for (let i = 1; i < spec.billTo.length; i++) {
    text(spec.billTo[i], M, y, 9, font, SOFT);
    y -= 12;
  }
  y -= 18;

  // Table header
  const cAmount = width - M;
  const cUnit = cAmount - 90;
  const cQty = cUnit - 70;
  page.drawRectangle({ x: M, y: y - 4, width: width - 2 * M, height: 22, color: rgb(0.96, 0.97, 0.98) });
  text("DESCRIPTION", M + 6, y + 4, 9, bold, SOFT);
  right("QTY", cQty, y + 4, 9, bold, SOFT);
  right("UNIT", cUnit, y + 4, 9, bold, SOFT);
  right("AMOUNT", cAmount - 6, y + 4, 9, bold, SOFT);
  y -= 22;

  for (const li of spec.lines) {
    text(li.description, M + 6, y, 10);
    if (li.qty != null) right(String(li.qty), cQty, y, 10);
    if (li.unitPrice != null) right(money(li.unitPrice), cUnit, y, 10);
    right(`${spec.symbol}${money(li.amount)}`, cAmount - 6, y, 10);
    y -= 8;
    page.drawLine({ start: { x: M, y }, end: { x: width - M, y }, thickness: 0.5, color: LINE });
    y -= 16;
  }

  // Totals
  y -= 6;
  const labelX = cUnit;
  const valX = cAmount - 6;
  right("Subtotal", labelX, y, 10, font, SOFT);
  right(`${spec.symbol}${money(spec.subtotal)}`, valX, y, 10);
  y -= 16;
  right(spec.taxLabel, labelX, y, 10, font, SOFT);
  right(`${spec.symbol}${money(spec.tax)}`, valX, y, 10);
  y -= 6;
  page.drawLine({ start: { x: labelX - 40, y }, end: { x: width - M, y }, thickness: 0.5, color: LINE });
  y -= 18;
  right("TOTAL DUE", labelX, y, 12, bold);
  right(`${spec.currency} ${spec.symbol}${money(spec.total)}`, valX, y, 12, bold, ACCENT);

  // Footer
  text(
    "Thank you. Remit within terms to the account on file. Fictional demo document.",
    M,
    M,
    8,
    font,
    SOFT,
  );
}

async function writeInvoice(spec: InvoiceSpec, filename: string) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  drawInvoicePdf(spec, doc, font, bold);
  const bytes = await doc.save();
  writeFileSync(join(OUT_DIR, filename), bytes);
  console.log("wrote", filename);
}

// --- Receipt PNG (image/vision path) ----------------------------------------
function writeReceiptPng(filename: string) {
  const W = 380;
  const H = 520;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#111111";

  const center = (s: string, y: number, size: number, bold = false) => {
    ctx.font = `${bold ? "bold " : ""}${size}px "Courier New", monospace`;
    const w = ctx.measureText(s).width;
    ctx.fillText(s, (W - w) / 2, y);
  };
  const rowLR = (l: string, r: string, y: number, size = 15) => {
    ctx.font = `${size}px "Courier New", monospace`;
    ctx.fillText(l, 24, y);
    const w = ctx.measureText(r).width;
    ctx.fillText(r, W - 24 - w, y);
  };
  const rule = (y: number) => {
    ctx.strokeStyle = "#999";
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(24, y);
    ctx.lineTo(W - 24, y);
    ctx.stroke();
    ctx.setLineDash([]);
  };

  center("THE CORNER CAFE", 48, 20, true);
  center("14 Harbour Lane, Portside", 70, 13);
  center("Receipt CC-4471", 90, 13);
  center("2026-06-18  09:42", 110, 13);
  rule(126);

  let y = 156;
  rowLR("2x Flat White", "9.00", y);
  y += 26;
  rowLR("1x Almond Croissant", "5.25", y);
  y += 26;
  rowLR("1x Avocado Toast", "12.50", y);
  y += 20;
  rule(y);
  y += 30;

  rowLR("Subtotal", "26.75", y);
  y += 26;
  rowLR("GST 10%", "2.68", y);
  y += 20;
  rule(y);
  y += 32;
  ctx.font = 'bold 18px "Courier New", monospace';
  ctx.fillText("TOTAL", 24, y);
  const t = "AUD 29.43";
  const tw = ctx.measureText(t).width;
  ctx.fillText(t, W - 24 - tw, y);
  y += 40;
  center("Paid — Visa ****2231", y, 13);
  y += 22;
  center("Fictional demo receipt", y, 11);

  writeFileSync(join(OUT_DIR, filename), canvas.toBuffer("image/png"));
  console.log("wrote", filename);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  await writeInvoice(
    {
      vendor: "Northwind Services Co.",
      vendorLine2: "Suite 300, 88 Cedar Avenue · billing@northwind.example",
      number: "NW-2026-0417",
      issueDate: "2026-06-02",
      dueDate: "2026-07-02",
      currency: "USD",
      symbol: "$",
      billTo: ["Tessera, Inc.", "Accounts Payable", "1 Market Plaza"],
      lines: [
        { description: "Cloud migration consulting (32 hrs)", qty: 32, unitPrice: 145, amount: 4640 },
        { description: "Security audit — Q3", amount: 2200 },
        { description: "On-call support retainer", amount: 1500 },
      ],
      subtotal: 8340,
      taxLabel: "Sales tax 8.5%",
      tax: 708.9,
      total: 9048.9,
    },
    "northwind-services-invoice.pdf",
  );

  await writeInvoice(
    {
      vendor: "Orbit Supply Ltd.",
      vendorLine2: "Unit 5, Enterprise Park · ar@orbitsupply.example",
      number: "OS-88213",
      issueDate: "2026-05-21",
      dueDate: "2026-06-20",
      currency: "USD",
      symbol: "$",
      billTo: ["Tessera, Inc.", "Facilities", "1 Market Plaza"],
      lines: [
        { description: "USB-C docking station", qty: 6, unitPrice: 189.0, amount: 1134.0 },
        { description: '27" 4K monitor', qty: 4, unitPrice: 342.5, amount: 1370.0 },
        { description: "Mechanical keyboard", qty: 10, unitPrice: 78.9, amount: 789.0 },
        { description: "Desk cable tray", qty: 12, unitPrice: 24.5, amount: 294.0 },
      ],
      subtotal: 3587.0,
      taxLabel: "Sales tax 7%",
      tax: 251.09,
      total: 3838.09,
    },
    "orbit-supply-invoice.pdf",
  );

  writeReceiptPng("corner-cafe-receipt.png");
  console.log("done. samples in", OUT_DIR);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
