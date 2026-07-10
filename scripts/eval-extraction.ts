/**
 * SROIE extraction eval. Runs the real extraction pipeline (lib/extract.ts,
 * native Anthropic API) over the committed ICDAR-2019 SROIE receipts in
 * data/eval/ and scores field-level exact-match accuracy after normalization.
 *
 * Mapping (our schema -> SROIE task-3 keys):
 *   vendor    -> company   (case + whitespace normalized)
 *   issueDate -> date      (parsed to canonical YYYY-MM-DD)
 *   total     -> total     (numeric, currency/commas stripped)
 * (SROIE's `address` has no counterpart in our schema and is not scored.)
 *
 * Needs ANTHROPIC_API_KEY at runtime. Without it, prints a friendly message and
 * exits 1 — this eval is designed to typecheck and fail gracefully, not to pass
 * without a key. Exits 1 if overall accuracy is below the 75% threshold.
 *
 * Run:  npm run eval   (after copying .env.example -> .env.local and adding a key)
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractInvoice, MissingApiKeyError } from "@/lib/extract";
import type { Invoice } from "@/lib/schema";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = join(HERE, "..", "data", "eval");
const THRESHOLD = 0.75;

interface Truth {
  company: string;
  date: string;
  address: string;
  total: string;
}

/** Minimal .env.local loader (no dep) so `npm run eval` works after copying the example. */
function loadEnvLocal() {
  const path = join(HERE, "..", ".env.local");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

// --- Normalizers ------------------------------------------------------------
const normCompany = (s: string) => s.trim().toUpperCase().replace(/\s+/g, " ");
const pad = (n: string) => n.padStart(2, "0");

/** Parse ISO or day-first (DD/MM/YYYY, common in SROIE) to canonical YYYY-MM-DD, or null. */
function normDate(s: string): string | null {
  const v = s.trim();
  if (!v) return null;
  const iso = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return `${iso[1]}-${pad(iso[2])}-${pad(iso[3])}`;
  const parts = v.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/);
  if (parts) {
    let [, d, m, y] = parts;
    if (y.length === 2) y = `20${y}`;
    // SROIE receipts are day-first.
    return `${y}-${pad(m)}-${pad(d)}`;
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/** Strip currency symbols / thousands separators to a fixed-2 numeric string, or null. */
function normTotal(s: string | number): string | null {
  const cleaned = String(s).replace(/[^0-9.\-]/g, "");
  const n = Number.parseFloat(cleaned);
  return Number.isNaN(n) ? null : n.toFixed(2);
}

interface Row {
  id: string;
  company: boolean;
  date: boolean;
  total: boolean;
  error?: string;
}

function scoreOne(truth: Truth, inv: Invoice): Omit<Row, "id"> {
  const company = normCompany(inv.vendor) === normCompany(truth.company);
  const dt = normDate(inv.issueDate);
  const date = dt !== null && dt === normDate(truth.date);
  const tt = normTotal(inv.total);
  const total = tt !== null && tt === normTotal(truth.total);
  return { company, date, total };
}

function tick(b: boolean) {
  return b ? "  ✓  " : "  ✗  ";
}

async function main() {
  loadEnvLocal();

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "\n  ANTHROPIC_API_KEY is not set.\n" +
        "  The SROIE eval calls the live Anthropic API, so it needs a key.\n" +
        "  Copy .env.example to .env.local and add your key, then re-run `npm run eval`.\n",
    );
    process.exit(1);
  }

  const ids = readdirSync(EVAL_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .filter((id) => existsSync(join(EVAL_DIR, `${id}.jpg`)))
    .sort();

  if (ids.length === 0) {
    console.error(`No eval samples found in ${EVAL_DIR}`);
    process.exit(1);
  }

  console.log(`\nRunning extraction eval over ${ids.length} SROIE receipts…\n`);
  console.log(`  ${"ID".padEnd(16)} company  date  total`);
  console.log(`  ${"-".repeat(16)} -------  ----  -----`);

  const rows: Row[] = [];
  for (const id of ids) {
    const truth = JSON.parse(readFileSync(join(EVAL_DIR, `${id}.json`), "utf8")) as Truth;
    try {
      const bytes = readFileSync(join(EVAL_DIR, `${id}.jpg`));
      const { invoice } = await extractInvoice(bytes, "image/jpeg");
      const s = scoreOne(truth, invoice);
      rows.push({ id, ...s });
      console.log(`  ${id.padEnd(16)}${tick(s.company)}  ${tick(s.date)} ${tick(s.total)}`);
    } catch (err) {
      if (err instanceof MissingApiKeyError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      rows.push({ id, company: false, date: false, total: false, error: msg });
      console.log(`  ${id.padEnd(16)}  err — ${msg.slice(0, 40)}`);
    }
  }

  // Per-field + overall accuracy.
  const n = rows.length;
  const sum = (k: "company" | "date" | "total") => rows.filter((r) => r[k]).length;
  const cCompany = sum("company");
  const cDate = sum("date");
  const cTotal = sum("total");
  const correct = cCompany + cDate + cTotal;
  const totalFields = n * 3;
  const overall = correct / totalFields;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

  console.log(`\n  Per-field accuracy (${n} docs):`);
  console.log(`    company : ${pct(cCompany / n)}  (${cCompany}/${n})`);
  console.log(`    date    : ${pct(cDate / n)}  (${cDate}/${n})`);
  console.log(`    total   : ${pct(cTotal / n)}  (${cTotal}/${n})`);
  console.log(`\n  Overall : ${pct(overall)}  (${correct}/${totalFields})  · threshold ${pct(THRESHOLD)}\n`);

  if (overall < THRESHOLD) {
    console.error(`  FAIL — overall ${pct(overall)} is below the ${pct(THRESHOLD)} threshold.\n`);
    process.exit(1);
  }
  console.log(`  PASS — overall ${pct(overall)} meets the ${pct(THRESHOLD)} threshold.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
