// Single source of truth for Reloop's subscription tiers, output formats, and
// per-tier permissions. The backend enforces these rules; the frontend reads
// them (via /api/check-subscription) instead of hardcoding its own copy.
//
// Extending later:
//   - New output format  -> add one entry to ALL_FORMATS and list its `key`
//     in whichever plans should include it.
//   - New product/tier    -> add another entry to PLAN_RULES.
//
// Files live under /api/_lib so Vercel does NOT treat them as routes
// (paths beginning with "_" are ignored by the build).

// Every output format the "repurpose" feature can produce, in display order.
// `key` must match the [LABEL] tags repurpose.js parses out of the model output.
const ALL_FORMATS = [
  { key: 'thread',     label: 'Social Thread' },
  { key: 'newsletter', label: 'Newsletter Section' },
  { key: 'clip',       label: 'Clip Script' },
  { key: 'quote',      label: 'Quote Card' },
];

// Per-tier rules. `weeklyInputs: null` means unlimited (JSON-safe; Infinity is not).
// `formats` lists the ALL_FORMATS keys that tier may generate.
// `video` is whether the tier may use the video-clipping feature.
const PLAN_RULES = {
  Starter: {
    label: 'Starter',
    formats: ['thread', 'newsletter', 'quote'],
    video: false,
    weeklyInputs: 1,
  },
  Studio: {
    label: 'Studio',
    formats: ['thread', 'newsletter', 'clip', 'quote'],
    video: true,
    weeklyInputs: 5,
  },
  Agency: {
    label: 'Agency',
    formats: ['thread', 'newsletter', 'clip', 'quote'],
    video: true,
    weeklyInputs: null,
  },
};

// Admins bypass all subscription, tier, and usage checks — full access always,
// independent of billing (so a lapsed Stripe subscription can't lock an owner
// out). Grant by setting subscribers.is_admin = true.
const ADMIN_RULES = {
  label: 'Admin',
  formats: ALL_FORMATS.map((f) => f.key),
  video: true,
  weeklyInputs: null, // unlimited
};

// The rolling window used for "inputs per week". A rolling 7-day window (rather
// than a fixed calendar week) avoids timezone edge cases and burst-at-midnight
// gaming. Change here if the product ever wants a fixed weekly reset.
const USAGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function rulesFor(plan) {
  return PLAN_RULES[plan] || null;
}

// --- Supabase helpers (service key — backend only) -------------------------
// All reads/writes below use SUPABASE_SERVICE_KEY, which must never reach the
// frontend. They power subscription + usage enforcement in the paid endpoints.

const SB_URL = () => process.env.SUPABASE_URL;
const SB_HEADERS = () => ({
  'Content-Type': 'application/json',
  apikey: process.env.SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
});

// Returns { status, plan } for an email, or null if not found / on error.
async function getSubscriber(email) {
  if (!email) return null;
  try {
    const url = `${SB_URL()}/rest/v1/subscribers?email=eq.${encodeURIComponent(
      email
    )}&select=status,plan,is_admin&limit=1`;
    const res = await fetch(url, { headers: SB_HEADERS() });
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch (err) {
    console.error('getSubscriber error:', err);
    return null;
  }
}

// Counts usage_events for this email within the rolling window.
async function countRecentUsage(email) {
  if (!email) return 0;
  const since = new Date(Date.now() - USAGE_WINDOW_MS).toISOString();
  const url = `${SB_URL()}/rest/v1/usage_events?email=eq.${encodeURIComponent(
    email
  )}&created_at=gte.${since}&select=id`;
  const res = await fetch(url, {
    headers: { ...SB_HEADERS(), Prefer: 'count=exact' },
  });
  if (!res.ok) {
    // Fail closed would block paying users on a transient error; fail open on
    // the *count* but callers still verify the subscription itself.
    console.error('countRecentUsage failed:', res.status, await res.text());
    return 0;
  }
  // PostgREST returns the exact count in the Content-Range header: "0-24/25".
  const range = res.headers.get('content-range') || '';
  const total = parseInt(range.split('/')[1], 10);
  if (!Number.isNaN(total)) return total;
  const rows = await res.json();
  return Array.isArray(rows) ? rows.length : 0;
}

// Records one usage event (kind: 'repurpose' | 'clip'). Best-effort.
async function recordUsage(email, kind) {
  if (!email) return;
  try {
    const res = await fetch(`${SB_URL()}/rest/v1/usage_events`, {
      method: 'POST',
      headers: SB_HEADERS(),
      body: JSON.stringify({ email, kind }),
    });
    if (!res.ok) {
      console.error('recordUsage failed:', res.status, await res.text());
    }
  } catch (err) {
    console.error('recordUsage error:', err);
  }
}

// Central authorization check for the paid endpoints. Given a logged-in user's
// email and the action they want, returns either { ok: true, subscriber, rules,
// usage } or { ok: false, status, error } with an HTTP status to return.
//   need: 'repurpose' | 'clip'
async function authorizeAction(email, need) {
  const subscriber = await getSubscriber(email);

  // Admin bypass: unlimited full access regardless of status, plan, or usage.
  if (subscriber && subscriber.is_admin) {
    return { ok: true, subscriber, rules: ADMIN_RULES, usage: { used: 0, limit: null } };
  }

  if (!subscriber || subscriber.status !== 'active') {
    return {
      ok: false,
      status: 403,
      error: 'No active Reloop subscription found for this account.',
    };
  }

  const rules = rulesFor(subscriber.plan);
  if (!rules) {
    return {
      ok: false,
      status: 403,
      error: 'Your plan could not be recognized. Contact support.',
    };
  }

  if (need === 'clip' && !rules.video) {
    return {
      ok: false,
      status: 403,
      error: `Video clipping isn't included on the ${rules.label} plan — upgrade to Studio to unlock it.`,
      upgrade: true,
    };
  }

  const used = await countRecentUsage(email);
  const limit = rules.weeklyInputs; // null = unlimited
  if (limit !== null && used >= limit) {
    return {
      ok: false,
      status: 429,
      error: `You've used all ${limit} of your weekly inputs on the ${rules.label} plan. Upgrade for more, or wait for your window to roll over.`,
      upgrade: true,
    };
  }

  return {
    ok: true,
    subscriber,
    rules,
    usage: { used, limit },
  };
}

module.exports = {
  ALL_FORMATS,
  PLAN_RULES,
  ADMIN_RULES,
  rulesFor,
  getSubscriber,
  countRecentUsage,
  recordUsage,
  authorizeAction,
};
