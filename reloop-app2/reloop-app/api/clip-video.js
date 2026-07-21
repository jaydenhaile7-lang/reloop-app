// Vercel serverless function — starts a Reap video-clipping job for a
// pasted YouTube link (or other public video URL). Requires the user to be
// logged in via Supabase AND on a tier that includes video clipping (Studio+),
// with weekly-input quota remaining. Same enforcement pattern as repurpose.js.
// Requires SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY, and
// REAP_API_KEY env vars.

const { authorizeAction, recordUsage } = require('./_lib/plans');

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

  // Subscription + video-permission + weekly-limit enforcement (backend-first).
  // authorizeAction rejects tiers without video (Starter) and quota-exhausted users.
  const auth = await authorizeAction(user.email, 'clip');
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error, upgrade: auth.upgrade });
  }

  const { videoUrl, uploadId, mode, focus } = req.body || {};
  if ((!videoUrl || !videoUrl.trim()) && !uploadId) {
    return res.status(400).json({ error: 'Paste a video link or upload a file first.' });
  }

  const MODE_PROMPTS = {
    highlight: 'Build a highlight reel of the very best moments in the video — peak energy, the strongest reactions, the most quotable lines, and the biggest emotional or visual climaxes. Prioritize moments that would still feel powerful out of context, and skip filler, intros, or set-up.',
    trailer: 'Generate a teaser-style trailer — pick suspenseful, attention-grabbing moments that hook the viewer without giving everything away. Look for cliffhangers, intriguing questions, bold setups, and emotional peaks that make viewers want to watch the full video.',
    compilation: 'Create a compilation of similar moments from across the video — clips that share a common theme, tone, or topic. Group them so they feel cohesive when watched back-to-back as a single themed reel.',
    topic: 'Find clips centered on a single topic or theme. Focus on moments where the speaker discusses one specific subject in depth, and skip tangents or unrelated digressions.',
    hooks: 'Extract only the strongest hooks — the opening lines, bold statements, or attention-grabbing moments designed to stop a viewer mid-scroll. Look for surprising claims, questions, or pattern-interrupts.',
    quotes: 'Pull out the most quotable lines — punchy one-liners, memorable phrases, or sharp insights that work as standalone soundbites and would read well as text overlays or pull-quotes.',
    educational: 'Find educational moments — clear explanations, lessons, frameworks, or insights that teach the viewer something new. Prioritize clips that deliver real value or impart knowledge concisely.',
    listicle: 'Build a listicle-style breakdown — moments where the speaker enumerates points, steps, reasons, or tips in order. Look for "first…", "second…", "three reasons…", and similar list-driven structures.',
    storytelling: 'Pick out storytelling moments — narrative arcs with setup, conflict, and payoff. Look for personal anecdotes, case studies, or any segment where the speaker takes the viewer on a journey.',
    qa: 'Find clear question-and-answer exchanges — interview questions paired with strong responses, or moments where the speaker fields and addresses a specific question. Each clip should make sense as a standalone Q&A pair.',
    stats: 'Surface moments containing notable statistics, data points, or factual claims. Look for numbers, percentages, comparisons, or verified facts that lend credibility and would catch a viewer\'s attention.',
    tips: 'Extract practical tips and advice — short, actionable recommendations the audience can apply immediately. Each clip should deliver one concrete piece of guidance, not vague philosophy.',
    reactions: 'Find strong reaction moments — surprise, shock, laughter, awe, or visible emotional responses from anyone on screen. Look for facial expressions and unfiltered reactions that capture the moment\'s energy.',
    controversy: 'Surface controversial or polarizing moments — strong opinions, callouts, or statements likely to spark debate. Look for clips that take a clear stance or make claims people would react to in the comments.',
  };

  const basePrompt = MODE_PROMPTS[mode] || 'Find the strongest standalone moments that work as short vertical clips for TikTok, Reels, and Shorts.';
  const prompt = focus && focus.trim()
    ? `${basePrompt} Additionally: ${focus.trim()}.`
    : basePrompt;

  const sourceFields = uploadId
    ? { uploadId }
    : { sourceUrl: videoUrl.trim() };

  try {
    const reapRes = await fetch('https://public.reap.video/api/v1/automation/create-clips', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.REAP_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...sourceFields,
        genre: 'talking',
        reframeClips: true,
        exportOrientation: 'portrait',
        exportResolution: 1080,
        captionsPreset: 'system_beasty',
        enableEmojis: true,
        enableHighlights: true,
        prompt: prompt,
      }),
    });

    if (!reapRes.ok) {
      const errText = await reapRes.text();
      console.error('Reap create-clips error:', errText);
      return res.status(502).json({ error: 'Could not start video processing. Check the link and try again.' });
    }

    const data = await reapRes.json();
    // Count this clip job against the weekly limit (after a successful start).
    await recordUsage(user.email, 'clip');
    return res.status(200).json({ projectId: data.id, status: data.status });
  } catch (err) {
    console.error('clip-video error:', err);
    return res.status(500).json({ error: 'Something went wrong starting the clip job.' });
  }
};
