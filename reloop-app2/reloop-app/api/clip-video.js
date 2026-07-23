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

  const { videoUrl, uploadId, mode, focus, genre, length } = req.body || {};
  if ((!videoUrl || !videoUrl.trim()) && !uploadId) {
    return res.status(400).json({ error: 'Paste a video link or upload a file first.' });
  }

  // Reap accepts exactly these three genres (visual format of the video, not its
  // subject matter — that's what `mode`/prompt handles). Anything else is a 400
  // from their API, so fall back to their default rather than trusting the client.
  const VALID_GENRES = ['talking', 'screenshare', 'gaming'];
  const safeGenre = VALID_GENRES.includes(genre) ? genre : 'talking';

  // Reap picks its own clip lengths when clipDurations is omitted, which in
  // testing returned 54s and 84s clips — long for short-form. These map to the
  // [min,max] second ranges Reap accepts.
  const DURATION_PRESETS = {
    short: [[0, 30]],
    standard: [[30, 60]],
    under60: [[0, 30], [30, 60]],
  };
  const clipDurations = DURATION_PRESETS[length] || DURATION_PRESETS.under60;

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

  // Applied to every job regardless of mode. Without this, Reap will happily
  // return the video's outro — a sign-off with a like/subscribe request and
  // zero standalone value — because "strongest moment" doesn't exclude it.
  const EXCLUSIONS =
    ' Never select intros, outros, sign-offs, or moments where the speaker asks viewers to like, comment, subscribe or follow. Skip sponsor reads and channel plugs. Every clip must make sense on its own to someone who has never seen the source. Start each clip at a clean sentence boundary, never mid-phrase, and never on a filler opener such as "I\'m not going to lie", "so", "and", "basically" or "um" — cut to where the payoff actually begins.';

  const combinedPrompt = focus && focus.trim()
    ? `${basePrompt}${EXCLUSIONS} Additionally: ${focus.trim()}.`
    : `${basePrompt}${EXCLUSIONS}`;
  // Reap caps `prompt` at 1000 characters and rejects the whole job above that.
  // The focus field is free text, so clamp rather than let a long note 400 out.
  const prompt = combinedPrompt.length > 1000 ? combinedPrompt.slice(0, 1000) : combinedPrompt;

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
        genre: safeGenre,
        clipDurations,
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
