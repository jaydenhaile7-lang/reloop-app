// Vercel serverless function — the actual product. Takes pasted content,
// verifies the user is logged in via Supabase AND has an active subscription,
// then calls the Anthropic API to generate the formats their tier allows.
// Requires SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY, and
// ANTHROPIC_API_KEY env vars.

const { authorizeAction, recordUsage, ALL_FORMATS } = require('./_lib/plans');

// How each format is described to the model, keyed by the same keys used in
// _lib/plans.js. Adding a new format = add it here and to ALL_FORMATS.
const FORMAT_SPECS = {
  thread: 'A 6-post social media thread breaking down the key ideas.',
  newsletter: 'A short section (150-200 words) suitable for a newsletter digest.',
  clip: 'A 45-second short-form video talking-point script.',
  quote: 'One short, shareable pull-quote from the content.',
};

const labelFor = (key) =>
  (ALL_FORMATS.find((f) => f.key === key) || {}).label || key;

async function verifySupabaseUser(accessToken) {
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) return null;
  return res.json();
}

async function callClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API error: ${errText}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text || '';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  const user = await verifySupabaseUser(token);
  if (!user || !user.email) {
    return res.status(401).json({ error: 'Not logged in.' });
  }

  // Subscription + tier + weekly-limit enforcement (backend-first — the
  // dashboard gate is not trusted on its own).
  const auth = await authorizeAction(user.email, 'repurpose');
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error, upgrade: auth.upgrade });
  }

  const { text } = req.body || {};
  if (!text || text.trim().length < 20) {
    return res.status(400).json({ error: 'Paste in a bit more content first.' });
  }

  // Only generate the formats this tier is allowed to produce.
  const allowed = auth.rules.formats.filter((k) => FORMAT_SPECS[k]);
  if (allowed.length === 0) {
    return res.status(403).json({ error: 'Your plan has no output formats enabled.' });
  }

  try {
    const specLines = allowed
      .map((k) => `[${k.toUpperCase()}]: ${FORMAT_SPECS[k]}`)
      .join('\n');
    const headerList = allowed.map((k) => `[${k.toUpperCase()}]`).join(', ');

    const prompt = `You are Reloop, a content repurposing assistant. Given the source content below, produce the following, each clearly separated with these exact headers on their own line: ${headerList}

${specLines}

Source content:
"""
${text}
"""`;

    const raw = await callClaude(prompt);

    // Parse each allowed tag's block, up to the next allowed tag that appears.
    const positions = allowed
      .map((k) => ({ key: k, tag: `[${k.toUpperCase()}]`, idx: raw.indexOf(`[${k.toUpperCase()}]`) }))
      .filter((p) => p.idx !== -1)
      .sort((a, b) => a.idx - b.idx);

    const formats = positions.map((p, i) => {
      const from = p.idx + p.tag.length;
      const end = i + 1 < positions.length ? positions[i + 1].idx : raw.length;
      return { key: p.key, label: labelFor(p.key), text: raw.slice(from, end).trim() };
    });

    // Record the input against the weekly limit (best-effort; after success so a
    // failed generation doesn't burn a user's quota).
    await recordUsage(user.email, 'repurpose');

    return res.status(200).json({ formats, usage: { used: auth.usage.used + 1, limit: auth.usage.limit } });
  } catch (err) {
    console.error('repurpose error:', err);
    return res.status(500).json({ error: 'Something went wrong generating your content.' });
  }
};
