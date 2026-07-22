// Vercel serverless function — captures a landing-page lead from the
// "Get one repurposed set, free" form into MailerLite, so it can be followed
// up manually (the visitor still needs to tell us which post to sample).
//
// This replaces the old frontend-only mock, which showed "check your inbox"
// but never sent or stored anything.
//
// Public and unauthenticated by design — it can only ever add an email to a
// list, never read anything back. Email format/length are validated to keep
// obvious junk out of the list.
//
// Requires MAILERLITE_API_KEY.
// Optional MAILERLITE_LEADS_GROUP_ID — when set, leads land in their own group,
// kept separate from paying customers (who go to MAILERLITE_GROUP_ID via
// webhook.js). If unset, the lead is still captured in MailerLite, just
// ungrouped — deliberately never falls back to the customer group.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email } = req.body || {};
  const clean = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!clean || clean.length > 254 || !EMAIL_RE.test(clean)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  if (!process.env.MAILERLITE_API_KEY) {
    console.error('subscribe-lead: MAILERLITE_API_KEY is not set — lead dropped:', clean);
    return res.status(500).json({ error: "We couldn't sign you up just now. Try again shortly." });
  }

  try {
    const body = { email: clean };
    if (process.env.MAILERLITE_LEADS_GROUP_ID) {
      body.groups = [process.env.MAILERLITE_LEADS_GROUP_ID];
    }

    const r = await fetch('https://connect.mailerlite.com/api/subscribers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${process.env.MAILERLITE_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const text = await r.text();
      console.error('subscribe-lead: MailerLite failed:', r.status, text);
      return res.status(502).json({ error: "We couldn't sign you up just now. Try again shortly." });
    }

    console.log('Lead captured:', clean);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('subscribe-lead error:', err);
    return res.status(500).json({ error: "We couldn't sign you up just now. Try again shortly." });
  }
};
