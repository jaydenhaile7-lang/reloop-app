// Vercel serverless function — checks the status of a Reap clipping
// project, and once it's finished, returns the finished clip URLs.
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
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  const user = await verifySupabaseUser(token);
  if (!user) {
    return res.status(401).json({ error: 'Not logged in.' });
  }

  const { projectId } = req.query || {};
  if (!projectId) {
    return res.status(400).json({ error: 'Missing projectId.' });
  }

  try {
    const statusRes = await fetch(
      `https://public.reap.video/api/v1/automation/get-project-status?projectId=${encodeURIComponent(projectId)}`,
      { headers: { 'Authorization': `Bearer ${process.env.REAP_API_KEY}` } }
    );
    if (!statusRes.ok) {
      const errText = await statusRes.text();
      console.error('Reap get-project-status error:', errText);
      return res.status(502).json({ error: 'Could not check clip status.' });
    }
    const statusData = await statusRes.json();

    if (statusData.status !== 'completed') {
      return res.status(200).json({ status: statusData.status });
    }

    const clipsRes = await fetch(
      `https://public.reap.video/api/v1/automation/get-project-clips?projectId=${encodeURIComponent(projectId)}`,
      { headers: { 'Authorization': `Bearer ${process.env.REAP_API_KEY}` } }
    );
    if (!clipsRes.ok) {
      const errText = await clipsRes.text();
      console.error('Reap get-project-clips error:', errText);
      return res.status(502).json({ error: 'Clip finished processing but clips could not be retrieved.' });
    }
    const clipsData = await clipsRes.json();

    return res.status(200).json({ status: 'completed', clips: clipsData.clips || clipsData });
  } catch (err) {
    console.error('clip-status error:', err);
    return res.status(500).json({ error: 'Something went wrong checking clip status.' });
  }
};
