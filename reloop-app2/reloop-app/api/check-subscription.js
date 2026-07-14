// Vercel serverless function — checks whether an email has an active Reloop
// subscription, by looking it up in the Supabase "subscribers" table.
// The webhook.js function is what keeps that table up to date.
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY env vars (service key, not the anon key —
// this one is powerful and must only ever live in backend env vars, never the frontend).

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const url = `${process.env.SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}&select=status`;
    const response = await fetch(url, {
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      },
    });
    const rows = await response.json();
    const active = Array.isArray(rows) && rows.some(r => r.status === 'active');
    return res.status(200).json({ active });
  } catch (err) {
    console.error('check-subscription error:', err);
    return res.status(500).json({ error: 'Could not check subscription status.' });
  }
};
