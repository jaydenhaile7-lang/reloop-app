// Vercel serverless function — starts a Reap video-clipping job for a
// pasted YouTube link (or other public video URL). Requires the user to
// be logged in via Supabase, same pattern as repurpose.js.
// Requires SUPABASE_URL, SUPABASE_ANON_KEY, and REAP_API_KEY env vars.

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
  if (!user) {
    return res.status(401).json({ error: 'Not logged in.' });
  }

  const { videoUrl, focus } = req.body || {};
  if (!videoUrl || !videoUrl.trim()) {
    return res.status(400).json({ error: 'Paste a video link first.' });
  }

  const prompt = focus && focus.trim()
    ? `Extract only the moments related to: ${focus.trim()}. Skip filler, small talk, intros, and anything unrelated to that focus.`
    : 'Find the strongest standalone moments that work as short vertical clips for TikTok, Reels, and Shorts.';

  try {
    const reapRes = await fetch('https://public.reap.video/api/v1/automation/create-clips', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.REAP_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sourceUrl: videoUrl.trim(),
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
    return res.status(200).json({ projectId: data.id, status: data.status });
  } catch (err) {
    console.error('clip-video error:', err);
    return res.status(500).json({ error: 'Something went wrong starting the clip job.' });
  }
};
