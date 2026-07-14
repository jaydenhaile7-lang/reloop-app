// Vercel serverless function — creates a real Stripe Checkout session.
// Requires STRIPE_SECRET_KEY set as an environment variable in your Vercel project
// (never in this file, never in the frontend).

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Map plan names to Stripe Price IDs — set these as env vars once you've created
// the three Prices in your Stripe Dashboard (Products catalog).
const PRICE_IDS = {
  Starter: process.env.STRIPE_PRICE_STARTER,
  Studio: process.env.STRIPE_PRICE_STUDIO,
  Agency: process.env.STRIPE_PRICE_AGENCY,
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { plan } = req.body || {};
    const priceId = PRICE_IDS[plan];

    if (!priceId) {
      return res.status(400).json({ error: `Unknown or unconfigured plan: ${plan}` });
    }

    const origin = req.headers.origin || `https://${req.headers.host}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: 14,
      },
      success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/index.html`,
      allow_promotion_codes: true,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout session error:', err);
    return res.status(500).json({ error: 'Something went wrong creating checkout.' });
  }
};
