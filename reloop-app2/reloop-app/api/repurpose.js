// Vercel serverless function — the actual product. Takes pasted content,
// verifies the user is logged in via Supabase, and calls the Anthropic API
// to generate the four repurposed formats.
// Requires SUPABASE_URL, SUPABASE_ANON_KEY, and ANTHROPIC_API_KEY env vars.

async function verifySupabaseUser(accessToken) {
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'apikey': process.env.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${accessToken}`,
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
  if (!user) {
    return res.status(401).json({ error: 'Not logged in.' });
  }

  const { text } = req.body || {};
  if (!text || text.trim().length < 20) {
    return res.status(400).json({ error: 'Paste in a bit more content first.' });
  }

  try {
    const prompt = `You are Reloop, a content repurposing assistant. Given the source content below, produce four things, each clearly separated with these exact headers on their own line: [THREAD], [NEWSLETTER], [CLIP], [QUOTE]

[THREAD]: A 6-post social media thread breaking down the key ideas.
[NEWSLETTER]: A short section (150-200 words) suitable for a newsletter digest.
[CLIP]: A 45-second short-form video talking-point script.
[QUOTE]: One short, shareable pull-quote from the content.

Source content:
"""
${text}
"""`;

    const raw = await callClaude(prompt);

    const extract = (label, nextLabel) => {
      const start = raw.indexOf(`[${label}]`);
      if (start === -1) return '';
      const from = start + `[${label}]`.length;
      const end = nextLabel ? raw.indexOf(`[${nextLabel}]`, from) : raw.length;
      return raw.slice(from, end === -1 ? raw.length : end).trim();
    };

    const thread = extract('THREAD', 'NEWSLETTER');
    const newsletter = extract('NEWSLETTER', 'CLIP');
    const clip = extract('CLIP', 'QUOTE');
    const quote = extract('QUOTE', null);

    return res.status(200).json({ thread, newsletter, clip, quote });
  } catch (err) {
    console.error('repurpose error:', err);
    return res.status(500).json({ error: 'Something went wrong generating your content.' });
  }
};
