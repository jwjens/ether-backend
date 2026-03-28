# Ether Backend API

License management and Stripe webhook handler for Ether Global Technologies.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health check |
| POST | `/validate` | Validate a license key |
| POST | `/webhooks/stripe` | Stripe webhook receiver |
| POST | `/admin/create-license` | Manually create a license |
| GET | `/admin/licenses?secret=` | List all licenses |

## Deploy to Railway

1. Push this repo to GitHub
2. Go to railway.app → New Project → Deploy from GitHub
3. Add a PostgreSQL database
4. Set environment variables (see .env.example)
5. Done — Railway auto-deploys on every push

## Environment Variables

Set these in Railway dashboard → Variables:

- `STRIPE_SECRET_KEY` — from Stripe Dashboard → Developers → API keys
- `STRIPE_WEBHOOK_SECRET` — from Stripe Dashboard → Webhooks (after adding endpoint)
- `PRICE_PRO` — Stripe price ID for Ether Pro
- `PRICE_STATION` — Stripe price ID for Ether Station
- `RESEND_API_KEY` — from resend.com (free tier)
- `ADMIN_SECRET` — any long random string you choose
- `DATABASE_URL` — auto-set by Railway when you add PostgreSQL

## Stripe Webhook Setup

After deploying, go to Stripe Dashboard → Developers → Webhooks → Add endpoint:

- URL: `https://your-app.up.railway.app/webhooks/stripe`
- Events: `checkout.session.completed`, `customer.subscription.deleted`, `customer.subscription.updated`

Copy the webhook signing secret and add it as `STRIPE_WEBHOOK_SECRET`.

## Manual License Creation

To manually grant a license (e.g. for beta testers):

```bash
curl -X POST https://your-app.up.railway.app/admin/create-license \
  -H "Content-Type: application/json" \
  -d '{"secret":"YOUR_ADMIN_SECRET","email":"user@example.com","plan":"pro"}'
```

This creates the license and emails it automatically.

# Updated 03/27/2026 19:41:21
