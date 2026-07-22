// Vercel serverless function — receives Stripe webhook events (subscription created,
// payment failed, cancelled, etc). Point your Stripe webhook endpoint at:
//   https://yourdomain.vercel.app/api/webhook
// Requires STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, MAILERLITE_API_KEY,
// and MAILERLITE_GROUP_ID env vars.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Adds/updates a row in Supabase's "subscribers" table so the dashboard
// knows who currently has an active plan. Requires SUPABASE_URL and
// SUPABASE_SERVICE_KEY env vars.
async function upsertSupabaseSubscriber(email, status, plan) {
  if (!email) return;
  try {
    // Only include `plan` when we actually know it, so a cancellation event
    // (which doesn't carry a plan) doesn't overwrite the stored tier with null.
    const row = { email, status };
    if (plan) row.plan = plan;
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/subscribers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error('Supabase upsert failed:', res.status, text);
    } else {
      console.log('Supabase subscriber updated:', email, status);
    }
  } catch (err) {
    console.error('Supabase request error:', err);
  }
}
async function addToMailerLite(email) {
  if (!email) return;
  try {
    const res = await fetch('https://connect.mailerlite.com/api/subscribers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.MAILERLITE_API_KEY}`,
      },
      body: JSON.stringify({
        email,
        groups: [process.env.MAILERLITE_GROUP_ID],
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error('MailerLite add-subscriber failed:', res.status, text);
    } else {
      console.log('Added to MailerLite:', email);
    }
  } catch (err) {
    console.error('MailerLite request error:', err);
  }
}

// Vercel needs the raw body for Stripe's signature check — disable the default parser.
module.exports.config = {
  api: { bodyParser: false },
};

function buffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', (chunk) => chunks.push(chunk));
    readable.on('end', () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method not allowed');
  }

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const rawBody = await buffer(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the events that matter for a subscription business.
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const email = session.customer_details?.email;
      const plan = session.metadata?.plan; // stamped in create-checkout-session.js
      console.log('New subscription started:', email, 'plan:', plan);
      await addToMailerLite(email);
      await upsertSupabaseSubscriber(email, 'active', plan);
      break;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      // TODO: trigger a "payment failed, update your card" email.
      console.log('Payment failed for customer:', invoice.customer);
      break;
    }
    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      console.log('Subscription cancelled:', subscription.customer);
      try {
        const customer = await stripe.customers.retrieve(subscription.customer);
        await upsertSupabaseSubscriber(customer.email, 'cancelled');
      } catch (err) {
        console.error('Could not look up cancelled customer email:', err);
      }
      break;
    }
    default:
      // Other event types are ignored for now.
      break;
  }

  return res.status(200).json({ received: true });
};
