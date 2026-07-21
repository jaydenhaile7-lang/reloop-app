// Vercel serverless function — checks whether an email has an active Reloop
// subscription, and returns the plan tier, that tier's rules, and current
// weekly usage so the dashboard can render the right features/limits.
// The webhook.js function keeps the "subscribers" table up to date.
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY env vars (service key, not the
// anon key — this one is powerful and must only ever live in backend env vars,
// never the frontend).

const { rulesFor, countRecentUsage, ALL_FORMATS } = require('./_lib/plans');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const url = `${process.env.SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(
      email
    )}&select=status,plan`;
    const response = await fetch(url, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      },
    });
    const rows = await response.json();
    const row = Array.isArray(rows) ? rows.find((r) => r.status === 'active') : null;

    if (!row) {
      return res.status(200).json({ active: false });
    }

    const rules = rulesFor(row.plan);
    // If the plan string is unrecognized, treat as active but with no rules so
    // the frontend can show a gentle "contact support" state rather than crash.
    const used = await countRecentUsage(email);

    return res.status(200).json({
      active: true,
      plan: row.plan || null,
      // Everything the frontend needs to render features/limits, derived from
      // the single source of truth in _lib/plans.js.
      rules: rules
        ? {
            label: rules.label,
            formats: rules.formats,
            video: rules.video,
            weeklyInputs: rules.weeklyInputs, // null = unlimited
          }
        : null,
      usage: { used, limit: rules ? rules.weeklyInputs : null },
      allFormats: ALL_FORMATS,
    });
  } catch (err) {
    console.error('check-subscription error:', err);
    return res.status(500).json({ error: 'Could not check subscription status.' });
  }
};
