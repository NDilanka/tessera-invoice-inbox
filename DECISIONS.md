# Design decisions

Short, honest notes on the choices that shaped this demo — including the tradeoffs.

## 1. Native Anthropic SDK, not an OpenAI-compatible gateway

The two sibling demos (`docs-chat`, `tessera-ops-agent`) both talk to models through
the OpenAI wire format (OpenRouter / Gemini / the Vercel AI SDK). This repo
deliberately does the opposite: it calls the **native Anthropic API** via
`@anthropic-ai/sdk`.

Why: the whole point of this demo is document extraction from **PDFs and images**, and
the native API has first-class, well-documented content blocks for both — the
`document` block (base64 PDF, Claude renders each page and reads text + layout) and the
`image` block for vision. Routing that through an OpenAI-compat shim would mean fighting
the lowest-common-denominator surface for exactly the feature the demo is about. Using
the native SDK also lets me use **tool use with `strict: true`** (see #2) cleanly.
Cost of the choice: model swaps are no longer a one-line base-URL change the way they
are in the siblings — but that's the right trade when the provider's own document API is
the star of the show. Across the three demos this is intentional: show fluency with
*both* the OpenAI-compatible ecosystem and the native Anthropic API.

## 2. Tool-use-enforced schema, not JSON prompting

Extraction goes through a single tool (`record_invoice`) whose `input_schema` is the
JSON-Schema form of our Zod model, declared with `strict: true`. The API guarantees the
model's tool input validates against that schema; we then re-parse with Zod so a bad
payload fails loudly at the boundary instead of corrupting the UI.

The alternative — "return JSON that looks like `{...}`" in a normal completion, then
`JSON.parse()` — is fragile: models wrap JSON in prose, emit trailing commas, or drop a
required field, and you discover it at parse time in production. Enforcing the shape at
the API means the *structure* is never the failure mode; only the *values* can be wrong,
which is exactly what the confidence system is for.

## 3. Two confidence signals (model + deterministic), not model-only

Each field's review status is the **worst of** the model's self-reported
`high/medium/low` confidence and a set of **deterministic checks computed in code**
(line items must sum to subtotal/total; `subtotal + tax` must reconcile to total; dates
must parse). 

Model-only confidence has a well-known failure mode: models are often *confidently
wrong*, especially on smudged totals or ambiguous dates. A deterministic arithmetic
check can't be talked into agreeing with a wrong number — if the line items don't add
up, the total is flagged red no matter how sure the model was. Conversely, the model
catches things arithmetic can't (a mis-read vendor name). Fusing the two, and taking the
pessimistic side, gives a reviewer a trustworthy "look here first" signal. The
deterministic half also lives in a pure module (`lib/review.ts`) so the UI re-runs it
live as the human edits values.

## 4. SROIE receipts as third-party ground truth, not self-authored invoices

The eval grades against 30 receipts from the ICDAR-2019 **SROIE** dataset — real
scanned receipts with independently authored ground truth (company, date, total).

Honest caveat: **receipts are not invoices.** They're shorter, differently laid out, and
SROIE only labels three fields, so the eval doesn't exercise line-item extraction or due
dates. I could have authored a set of invoices *and* their "correct" answers myself and
scored 100% — but that measures nothing except my own consistency. A **third-party,
independently labeled** benchmark I don't control is a far more credible signal of real
extraction quality, even if the document type is an imperfect match. The demo's own
sample invoices cover the invoice-shaped layout; SROIE covers the "can it actually read
a real-world document it has never seen" question. Grading on data you didn't author
beats self-grading, full stop.

## 5. Conservative serverless upload caps

Uploads are capped at **4 MB** and **5 pages**, and only PDF/JPG/PNG are accepted, all
validated *before* any model call. 

Reasons: (a) serverless platforms (Vercel, etc.) cap request body size and function
duration, so a 30 MB / 200-page PDF would fail slowly and expensively rather than
cleanly; (b) invoices and receipts are short — 5 pages is generous — so the cap costs
real users nothing while bounding token spend and latency; (c) validating type/size/page
count at the boundary means a bad upload is a fast, friendly `413/415/422`, never a
half-processed request that burned an API call. The page count is checked with `pdf-lib`
before the document ever reaches the model.

## 6. Env-gated OpenRouter fallback for running the eval

Production talks to the **native Anthropic API** (decision #1), which needs `ANTHROPIC_API_KEY`.
To let the SROIE eval run against a funded **OpenRouter** account instead, there's an
env-gated fallback centralized in `lib/config.ts` (`resolveExtractionProvider`):

- `ANTHROPIC_API_KEY` set → direct Anthropic — **the production default, unchanged.**
- else `OPENROUTER_API_KEY` set → OpenRouter serving the **same model** (`anthropic/claude-haiku-4.5`, i.e. the same `claude-haiku-4-5` Anthropic serves).
- else → a friendly missing-key error.

Anthropic always wins when both are present, so nothing about the production path changes.

**Why the fallback isn't just a base-URL swap.** OpenRouter's docs
(https://openrouter.ai/docs) expose only an OpenAI-compatible
`/api/v1/chat/completions` route — there is **no** Anthropic-native `/v1/messages`
endpoint, so we can't simply point `@anthropic-ai/sdk` at an OpenRouter base URL
and reuse the native tool-use call. The fallback therefore lives only in the
extraction call path (`lib/extract.ts` → `callOpenRouter`), issuing the
OpenAI-compatible request directly. The existing strict tool schema is passed
through as an OpenAI `function` tool — that format accepts JSON Schema, so the
`anyOf`-nullable pattern for optional fields is preserved verbatim.

**Honest pipeline-mechanics differences to keep in mind when reading eval numbers:**

- **Image-only on the fallback.** The eval is image-based (SROIE `.jpg`), so
  `callOpenRouter` handles images (`image_url` data-URI) and deliberately refuses
  PDFs; native Anthropic keeps its first-class `document` block for PDFs in
  production. The eval exercises the same model either way.
- **Strict-mode enforcement.** On native Anthropic, `strict: true` is enforced by
  the API. Through OpenRouter, strictness depends on the upstream provider's
  handling of the OpenAI `strict` flag; either way we re-validate the tool output
  with the same Zod schema, so a malformed response fails at our boundary rather
  than reaching the UI.

Bottom line: eval metrics may be **measured via OpenRouter serving the same
`claude-haiku-4.5`**; the production default remains the native Anthropic API.

## 7. The extraction eval stays Anthropic-gated (no Gemini free-tier path)

The sibling ops-agent added a Gemini free-tier path so its tool-choice eval runs
at $0. We deliberately do **not** mirror that here.

**Decision.** The extraction eval remains gated on Anthropic (native
`ANTHROPIC_API_KEY`), with OpenRouter as the only fallback. Deploy waits for an
Anthropic key rather than green-lighting a free Gemini run.

**Why.**

- **Base64 image input through a Gemini OpenAI-compat layer is unverified.** This
  eval is image-based (SROIE `.jpg` → data-URI). Gemini's OpenAI-compatibility
  endpoint has known quirks around multimodal `image_url` payloads, and we have
  not confirmed it round-trips base64 images into the strict tool call cleanly.
  Publishing eval numbers off an unverified input path would be dishonest.
- **Native Anthropic strict tool-use is this repo's differentiator.** The whole
  point here is API-enforced `strict: true` structured extraction (decision #1).
  Measuring the eval through a compat shim that only best-effort honours the
  `strict` flag would undercut the exact property we are trying to demonstrate.
- **The OpenRouter fallback is an escape hatch, not a substitute.** It exists
  (decision #6) only so the eval *can* run without a direct Anthropic key; it is
  not a green light to characterize the model on a non-native path. When both
  keys are absent the eval simply refuses rather than silently degrading.

Bottom line: the differentiator is native Anthropic strict tool-use, so the eval
stays Anthropic-gated; OpenRouter remains an env-gated escape hatch and deploy
waits for an Anthropic key.
