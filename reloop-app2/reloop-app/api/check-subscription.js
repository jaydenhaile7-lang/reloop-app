// Vercel serverless function — checks whether an email has an active Reloop
// subscription (or is an admin), and returns the plan tier, that tier's rules,
// and current weekly usage so the dashboard can render the right features/limits.
// The webhook.js function keeps the "subscribers" table up to date.
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY env vars (service key, not the
// anon key — this one is powerful and must only ever live in backend env vars,
// never the frontend).

const { rulesFor, getSubscriber, countRecentUsage, ALL_FORMATS, ADMIN_RULES } = require('./_lib/plans');

// Shape a rules object for the frontend (drops nothing today, but keeps the
// public contract explicit and stable).
const publicRules = (r) => ({
  label: r.label,
  formats: r.formats,
  video: r.video,
  weeklyInputs: r.weeklyInputs, // null = unlimited
});

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const sub = await getSubscriber(email);
    if (!sub) {
      return res.status(200).json({ active: false });
    }

    // Admins are always fully unlocked, regardless of subscription status.
    if (sub.is_admin) {
      return res.status(200).json({
        active: true,
        admin: true,
        plan: ADMIN_RULES.label,
        rules: publicRules(ADMIN_RULES),
        usage: { used: 0, limit: null },
        allFormats: ALL_FORMATS,
      });
    }

    if (sub.status !== 'active') {
      return res.status(200).json({ active: false });
    }

    const rules = rulesFor(sub.plan);
    // If the plan string is unrecognized, treat as active but with no rules so
    // the frontend can show a gentle "contact support" state rather than crash.
    const used = await countRecentUsage(email);

    return res.status(200).json({
      active: true,
      plan: sub.plan || null,
      rules: rules ? publicRules(rules) : null,
      usage: { used, limit: rules ? rules.weeklyInputs : null },
      allFormats: ALL_FORMATS,
    });
  } catch (err) {
    console.error('check-subscription error:', err);
    return res.status(500).json({ error: 'Could not check subscription status.' });
  }
};
