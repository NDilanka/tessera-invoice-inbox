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
// @next/env is a CommonJS bundle; default-import + destructure so it works
// under this package's ESM ("type": "module") resolution.
import nextEnv from "@next/env";
import { extractInvoice, MissingApiKeyError } from "@/lib/extract";
import { EXTRACTION_MODEL, resolveAnthropicClientOptions } from "@/lib/config";

const { loadEnvConfig } = nextEnv;
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
  if (Number.isNaN(t)) return null;
  // Re-project the parsed instant into UTC components so the YYYY-MM-DD slice
  // is timezone-independent (a local-midnight parse would otherwise shift a day
  // west of UTC). e.g. "15 Jan 2019" → 2019-01-15 on any machine TZ.
  const d = new Date(t);
  const utc = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  return utc.toISOString().slice(0, 10);
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
  // Load .env.local (and the other Next env files) the same way next dev/build
  // do, so `npm run eval` works with keys in .env.local, not just the shell.
  loadEnvConfig(process.cwd());

  const clientOptions = resolveAnthropicClientOptions();
  if (!clientOptions) {
    console.error(
      "\n  No extraction provider is configured.\n" +
        "  The SROIE eval calls a live model, so it needs a key. Either:\n" +
        "    • ANTHROPIC_API_KEY  — direct Anthropic (production default), or\n" +
        "    • OPENROUTER_API_KEY — the same native SDK routed through OpenRouter's\n" +
        "                           Anthropic Skin (set EXTRACTION_MODEL=anthropic/claude-haiku-4.5).\n" +
        "  Copy .env.example to .env.local and add one, then re-run `npm run eval`.\n",
    );
    process.exit(1);
  }

  const via =
    "baseURL" in clientOptions
      ? `OpenRouter Anthropic Skin (${EXTRACTION_MODEL})`
      : `Anthropic (${EXTRACTION_MODEL}) — production default`;
  console.log(`\n  Provider: ${via}`);

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
