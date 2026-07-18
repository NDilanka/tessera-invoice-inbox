// Abuse guards for the public demo. Checked at the API boundary BEFORE any
// Anthropic call runs, so a burst of traffic can't run up the API bill.
//
// Ported from the sibling docs-chat repo (feat/claude-runtime-hardening). The
// provider differs — this repo calls the native Anthropic API directly — but the
// guard shape is identical: per-IP sliding window, UTC-day global cap, env-gated
// Turnstile, blocked requests never touch the daily counter.
//
// IMPORTANT: the rate-limit and daily-cap state below lives in module-scope
// Maps — i.e. in the memory of a single server process. On a serverless host
// (Vercel, Lambda) each instance has its own copy and instances come and go, so
// these limits are **per-instance best-effort**, not a global guarantee. They
// exist to blunt casual abuse and accidental loops. The real, hard backstop is
// a provider-side spend cap on the Anthropic key: set a monthly limit in the
// console and it physically cannot spend more than that.

import { PER_IP_LIMIT, WINDOW_MS, DAILY_CAP } from "@/lib/config";

const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// --- In-memory, per-instance state ------------------------------------------
// Maps live for the lifetime of the process. See the module header: best-effort
// on serverless; the spend cap is the real limit.
const ipHits = new Map<string, number[]>(); // ip -> recent request timestamps (ms)
const daily = { day: utcDay(), count: 0 }; // resets when the UTC day rolls over

function utcDay(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

/** Read the caller's IP from the first hop of x-forwarded-for; else "unknown". */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}

export type GuardVerdict =
  | { ok: true }
  | { ok: false; status: number; error: string; message: string };

const COOLING_DOWN: GuardVerdict = {
  ok: false,
  status: 429,
  error: "cooling_down",
  message: "The demo is cooling down. Try again in a minute.",
};

/**
 * Check the global daily cap and the per-IP sliding window. A served request is
 * recorded against both counters only when it is allowed through, so a blocked
 * caller doesn't burn the global daily budget. Call this AFTER Turnstile
 * verification (see runGuards) so a tokenless/failed request never reaches the
 * daily counter either.
 */
export function checkRateLimits(ip: string, now = Date.now()): GuardVerdict {
  // 1. Global daily cap (UTC-day kill-switch).
  const today = utcDay();
  if (daily.day !== today) {
    daily.day = today;
    daily.count = 0;
  }
  if (daily.count >= DAILY_CAP) return COOLING_DOWN;

  // Opportunistic bound: ipHits is only pruned for the requesting IP on each
  // call, so entries for IPs that never come back would otherwise linger
  // forever. Once the map grows past 1000 keys, sweep out any entry whose
  // timestamps are all outside the window. Keeps memory bounded without a
  // background timer.
  if (ipHits.size > 1000) {
    const staleCutoff = now - WINDOW_MS;
    for (const [key, hits] of ipHits) {
      if (hits.every((t) => t <= staleCutoff)) ipHits.delete(key);
    }
  }

  // 2. Per-IP sliding window over the last WINDOW_MS.
  const cutoff = now - WINDOW_MS;
  const recent = (ipHits.get(ip) ?? []).filter((t) => t > cutoff);
  if (recent.length >= PER_IP_LIMIT) {
    ipHits.set(ip, recent); // keep the pruned window so it decays correctly
    return COOLING_DOWN;
  }

  // Allowed — record the hit against both counters.
  recent.push(now);
  ipHits.set(ip, recent);
  daily.count += 1;
  return { ok: true };
}

/**
 * Cloudflare Turnstile verification — fully env-gated.
 * If TURNSTILE_SECRET_KEY is unset, verification is skipped entirely (ok).
 * If set, the request must carry a `turnstileToken` we verify server-side.
 */
export async function verifyTurnstile(
  token: string | undefined,
  ip: string,
): Promise<GuardVerdict> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: true }; // Turnstile disabled — nothing to check.

  const fail: GuardVerdict = {
    ok: false,
    status: 403,
    error: "turnstile_failed",
    message: "Please complete the verification and try again.",
  };
  if (!token) return fail;

  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip && ip !== "unknown") body.set("remoteip", ip);
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success ? { ok: true } : fail;
  } catch {
    // Network hiccup talking to Cloudflare — fail closed.
    return fail;
  }
}

/**
 * Run all abuse guards for a request. Returns { ok: true } to proceed, or a
 * verdict carrying the HTTP status + JSON error/message to return to the client.
 *
 * Order matters: Turnstile verification runs first, then the per-IP/daily rate
 * limits. This ensures a tokenless or failed-Turnstile request (403) never
 * increments the daily counter — only requests that clear every guard do.
 */
export async function runGuards(
  req: Request,
  turnstileToken: string | undefined,
): Promise<GuardVerdict> {
  const ip = clientIp(req);
  const turnstile = await verifyTurnstile(turnstileToken, ip);
  if (!turnstile.ok) return turnstile;
  return checkRateLimits(ip);
}
