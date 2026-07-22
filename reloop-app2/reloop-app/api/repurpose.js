// Vercel serverless function — the actual product. Takes pasted content,
// verifies the user is logged in via Supabase AND has an active subscription,
// then calls the Anthropic API to generate the formats their tier allows.
// Requires SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY, and
// ANTHROPIC_API_KEY env vars.

const { authorizeAction, recordUsage, ALL_FORMATS } = require('./_lib/plans');

// How each format is described to the model, keyed by the same keys used in
// _lib/plans.js. Adding a new format = add it here and to ALL_FORMATS.
//
// These specs are the product. They're written to produce platform-native
// output rather than a summary of the source — in particular the clip spec is
// built around the fact that short-form retention is won or lost in the first
// three seconds, so it demands an engineered hook, first-frame on-screen text,
// and cut-level pacing instead of a block of prose to read aloud.
const FORMAT_SPECS = {
  thread: `A social media thread that breaks down the key ideas.
- Open with a standalone hook post that makes someone stop scrolling. No "a thread 🧵", no throat-clearing.
- 5 to 7 posts total; use however many the material actually justifies, not a fixed count.
- Every post must make sense on its own if it's the only one someone sees.
- One idea per post. Short lines. No filler transitions like "and here's the thing".
- Land the final post on a concrete takeaway, not a summary of what you just said.`,

  newsletter: `A section (150-200 words) that slots into a newsletter digest.
- Assume the reader never saw the source. Don't reference "the post" or "the video".
- Lead with the sharpest idea, not background.
- Written to be read in a quiet inbox, not shouted — but never padded.`,

  clip: `A short-form video script (~45 seconds spoken) built to retain attention. Use exactly these four labelled sections, each on its own line:

HOOKS (3 options)
Three alternative opening lines, each of which lands its promise inside the first 3 seconds. No warm-up sentence, no "in this video", no restating the topic before the payoff. Vary the angle across the three: one curiosity/tension, one problem-then-fix, one blunt claim or result. Each under 15 words.

ON-SCREEN TEXT
3 to 7 words to burn onto the very first frame, in the viewer's language, high contrast. This is not the hook repeated verbatim — it's the promise compressed to its shortest readable form.

SCRIPT
The spoken script that follows the hook. Break it into short beats, one per line, each roughly 1-2 seconds of speech, so an editor knows exactly where to cut. Spoken rhythm, not written prose: short sentences, contractions, no subordinate clauses stacking up. Keep the payoff moving — never let more than a few seconds pass without something landing.

CTA
One short closing line telling the viewer exactly what to do next. Specific, not "follow for more".`,

  quote: `One short, shareable pull-quote.
- Must stand completely on its own with zero context.
- Ideally under 15 words. Cut every word that isn't load-bearing.
- Pull the sharpest line in the source, or sharpen it — don't invent a claim the source doesn't make.`,
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
      // Raised from 1500: the clip format alone now returns 3 hooks, on-screen
      // text, a beat-broken script and a CTA, so all four formats together
      // comfortably exceeded the old ceiling and got truncated mid-output.
      max_tokens: 3000,
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
      .map((k) => `[${k.toUpperCase()}]\n${FORMAT_SPECS[k]}`)
      .join('\n\n');
    const headerList = allowed.map((k) => `[${k.toUpperCase()}]`).join(', ');

    const prompt = `You are Reloop. You take one piece of content someone has already published and rebuild it into other formats — each one written natively for where it's going.

VOICE
Before writing anything, read the source closely for how this person writes: sentence length and rhythm, vocabulary, how blunt or formal they are, the phrasings they reach for, what they refuse to do. Write every output in that voice.
- Match them. Do not upgrade them into marketing copy.
- If the source is plain and direct, stay plain and direct. If it's funny, be funny in their way, not a generic way.
- Never add hype, exclamation marks, or emoji that aren't already in their writing.
- Their opinions are theirs — keep the edges. Don't sand a strong claim into something safe.

RULES
- Rebuild, don't summarize. Someone who never saw the source should get full value from each output on its own.
- Never reference the source ("in this post", "the article above", "as mentioned").
- No preamble and no sign-off. Give only the content itself.
- Cut hedging: "maybe", "I think", "kind of" — unless the source genuinely hedges there.
- Don't invent facts, numbers, or claims that aren't in the source.

OUTPUT
Produce the following, each separated by these exact headers on their own line: ${headerList}

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
