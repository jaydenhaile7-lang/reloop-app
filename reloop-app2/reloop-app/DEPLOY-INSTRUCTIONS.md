# Deploying Reloop's Checkout (Vercel)

This folder is a complete, deployable project: the landing page plus two serverless
functions that talk to Stripe for real. Your publishable key is already wired into
the frontend. You still need to add your **secret key** as an environment variable
on Vercel — never in this codebase.

## 1. Create Stripe Products & Prices (5 min)

Before deploying, create the three subscription prices in Stripe:

1. Stripe Dashboard → **Product catalog** → **Add product**.
2. Create three products: `Reloop Starter` ($19/mo), `Reloop Studio` ($49/mo), `Reloop Agency` ($149/mo).
3. For each, set the price as **Recurring — Monthly**.
4. After saving each product, copy its **Price ID** (starts with `price_...`) — you'll need all three in step 4.

## 2. Get a Vercel account

Go to vercel.com and sign up (free plan is fine — GitHub login is the fastest way in).

## 3. Deploy this folder

Easiest path — no command line needed:
1. Push this folder to a new GitHub repository (or use Vercel's drag-and-drop deploy if offered).
2. In Vercel: **Add New Project** → import that repository → **Deploy**.

(If you're comfortable with a terminal instead: install the Vercel CLI with
`npm i -g vercel`, then run `vercel` from inside this folder and follow the prompts.)

## 4. Add your environment variables

In your Vercel project: **Settings → Environment Variables**, add:

| Name | Value |
|---|---|
| `STRIPE_SECRET_KEY` | your `rk_test_...` or `sk_test_...` key |
| `STRIPE_PRICE_STARTER` | the Price ID for Starter |
| `STRIPE_PRICE_STUDIO` | the Price ID for Studio |
| `STRIPE_PRICE_AGENCY` | the Price ID for Agency |
| `STRIPE_WEBHOOK_SECRET` | see step 5 below |

Redeploy after adding these (Vercel prompts you, or push any small change to trigger it).

## 5. Connect the webhook

1. Stripe Dashboard → **Developers → Webhooks → Add endpoint**.
2. Endpoint URL: `https://YOUR-PROJECT-NAME.vercel.app/api/webhook`
3. Select events: `checkout.session.completed`, `invoice.payment_failed`, `customer.subscription.deleted`.
4. After creating it, Stripe shows a **Signing secret** (starts with `whsec_...`) — copy it into the `STRIPE_WEBHOOK_SECRET` environment variable in Vercel, then redeploy.

## 6. Test it end-to-end

While still in test mode, use Stripe's test card `4242 4242 4242 4242`, any future expiry, any CVC.
Click through the whole flow on your live Vercel URL and confirm:
- You land on `/success.html` after checkout
- The subscription appears in Stripe Dashboard → Customers
- Your webhook shows a successful delivery (Stripe Dashboard → Webhooks → your endpoint → recent events)

## 7. Go live

Once everything checks out: switch Stripe to **Live mode**, repeat steps 1 and 4–5 with
live-mode keys and live Price IDs, and you're accepting real payments.

---

## 8. Setting up the actual product (login + repurposing tool)

The dashboard where subscribers paste content and get results needs two more free/low-cost accounts.

### Supabase (login system + subscriber database)
1. Go to supabase.com, sign up, create a new project (pick a password for it, save it somewhere).
2. Once it's created, go to **Project Settings → API**. Copy three things:
   - **Project URL** → this is `SUPABASE_URL`
   - **anon public key** → this is `SUPABASE_ANON_KEY`
   - **service_role key** → this is `SUPABASE_SERVICE_KEY` (keep this one secret — it bypasses all security rules, backend only, never frontend)
3. Go to the **SQL Editor** in Supabase and run this once, to create the table that tracks who's subscribed:
   ```sql
   create table subscribers (
     email text primary key,
     status text not null default 'active',
     updated_at timestamp with time zone default now()
   );
   ```
4. In `public/login.html` and `public/dashboard.html`, replace `YOUR_SUPABASE_URL` and `YOUR_SUPABASE_ANON_KEY` with your real values from step 2 (these two are safe to put directly in frontend files).
5. In Vercel's Environment Variables, add:

| Name | Value |
|---|---|
| `SUPABASE_URL` | your Project URL |
| `SUPABASE_SERVICE_KEY` | your service_role key |
| `SUPABASE_ANON_KEY` | your anon public key |

### Anthropic API (the part that actually writes the repurposed content)
1. Go to console.anthropic.com, sign up, add a small amount of credit (a few dollars covers a lot of testing — this is pay-as-you-go, not a subscription).
2. Create an API key under **API Keys**.
3. Add it to Vercel's Environment Variables:

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your API key |

### Redeploy
After adding all of the above (Supabase's 3 values, the Anthropic key, plus the earlier MailerLite ones), redeploy on Vercel so the live site picks them up.

### Test the whole product flow
1. Go to `/login.html` on your site, enter the email you used to subscribe with Stripe's test card.
2. Check your inbox for the magic link, click it.
3. You should land on `/dashboard.html` and see the paste-in box (not the "no subscription" message — if you see that instead, double check the `subscribers` table has a row for that email with status `active`).
4. Paste in a paragraph or two of any text, click **Repurpose this**, and confirm you get back a thread, newsletter section, clip script, and quote.

---

### What's still manual
- Loading the email sequences into MailerLite (once you've connected that account, I can do this directly).
- Anything requiring your Stripe, Vercel, Supabase, or Anthropic login — I can't access those accounts myself, only write the code that uses them.
