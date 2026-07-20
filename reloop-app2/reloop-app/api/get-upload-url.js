// Vercel serverless function — requests a presigned upload URL from Reap
// so the browser can upload a video file directly (not through our own
// server, which avoids Vercel's function payload/size limits).
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

  const { filename } = req.body || {};
  if (!filename || !filename.trim()) {
    return res.status(400).json({ error: 'Missing filename.' });
  }

  try {
    const reapRes = await fetch('https://public.reap.video/api/v1/automation/get-upload-url', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.REAP_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filename: filename.trim() }),
    });

    if (!reapRes.ok) {
      const errText = await reapRes.text();
      console.error('Reap get-upload-url error:', errText);
      return res.status(502).json({ error: 'Could not prepare the upload. Try again.' });
    }

    const data = await reapRes.json();
    return res.status(200).json({ uploadUrl: data.uploadUrl, uploadId: data.id });
  } catch (err) {
    console.error('get-upload-url error:', err);
    return res.status(500).json({ error: 'Something went wrong preparing the upload.' });
  }
};
