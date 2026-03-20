require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const Stripe = require('stripe');
const crypto = require('crypto');
const { Resend } = require('resend');

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── Middleware ──
app.use(cors({ origin: '*' }));

// Raw body needed for Stripe webhooks BEFORE json parser
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── DB Init ──
async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS licenses (
      id SERIAL PRIMARY KEY,
      license_key TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      plan TEXT NOT NULL CHECK (plan IN ('pro', 'station')),
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      status TEXT DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'expired')),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      activated_at TIMESTAMPTZ,
      last_validated_at TIMESTAMPTZ
    )
  `);
  console.log('DB ready');
}

// ── License key generator ──
function generateLicenseKey(plan) {
  const prefix = plan === 'pro' ? 'ETHER-PRO' : 'ETHER-STA';
  const part1 = crypto.randomBytes(2).toString('hex').toUpperCase();
  const part2 = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${prefix}-${part1}-${part2}`;
}

// ── Send license email ──
async function sendLicenseEmail(email, licenseKey, plan) {
  const planName = plan === 'pro' ? 'Ether Pro' : 'Ether Station';
  const price = plan === 'pro' ? '$10/month' : '$50/month';

  await resend.emails.send({
    from: 'Ether Global Technologies <licenses@etherradio.app>',
    to: email,
    subject: `Your ${planName} License Key`,
    html: `
      <!DOCTYPE html>
      <html>
      <head><meta charset="UTF-8"></head>
      <body style="background:#080810;color:#f0f0f8;font-family:Arial,sans-serif;padding:40px;max-width:560px;margin:0 auto;">
        <div style="margin-bottom:32px;">
          <div style="font-size:24px;font-weight:700;letter-spacing:-0.02em;">ETHER</div>
          <div style="font-size:9px;letter-spacing:0.22em;color:#22d3ee;">GLOBAL TECHNOLOGIES</div>
        </div>
        <h1 style="font-size:22px;font-weight:700;margin-bottom:8px;">Your license is ready.</h1>
        <p style="color:rgba(255,255,255,0.55);font-size:14px;margin-bottom:32px;">
          Thank you for subscribing to ${planName} (${price}). Here's your license key:
        </p>
        <div style="background:#0d0d1a;border:1px solid rgba(34,211,238,0.3);border-radius:12px;padding:24px;text-align:center;margin-bottom:32px;">
          <div style="font-family:monospace;font-size:22px;font-weight:700;letter-spacing:0.1em;color:#22d3ee;">${licenseKey}</div>
        </div>
        <div style="background:#0d0d1a;border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:20px;margin-bottom:32px;">
          <div style="font-weight:700;margin-bottom:12px;font-size:13px;">How to activate:</div>
          <ol style="color:rgba(255,255,255,0.55);font-size:13px;line-height:1.8;padding-left:20px;margin:0;">
            <li>Open Ether on your computer</li>
            <li>Click the menu (☰) in the top left</li>
            <li>Click <strong style="color:#f0f0f8;">Subscription</strong></li>
            <li>Click <strong style="color:#f0f0f8;">Enter License Key</strong></li>
            <li>Enter this email address and the key above</li>
          </ol>
        </div>
        <p style="color:rgba(255,255,255,0.3);font-size:12px;">
          Questions? Reply to this email or join our Discord: <a href="https://discord.gg/RmHRGtpy" style="color:#22d3ee;">discord.gg/RmHRGtpy</a>
        </p>
        <p style="color:rgba(255,255,255,0.2);font-size:11px;margin-top:24px;">
          Ether Global Technologies · <a href="https://jwjens.github.io/ether" style="color:rgba(255,255,255,0.3);">jwjens.github.io/ether</a>
        </p>
      </body>
      </html>
    `
  });
}

// ── Routes ──

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Ether License API', version: '1.0.0' });
});

// Validate a license key
app.post('/validate', async (req, res) => {
  const { license_key, email } = req.body;
  if (!license_key) return res.status(400).json({ valid: false, error: 'Missing license_key' });

  try {
    const result = await db.query(
      'SELECT * FROM licenses WHERE license_key = $1 AND status = $2',
      [license_key.trim().toUpperCase(), 'active']
    );

    if (result.rows.length === 0) {
      return res.json({ valid: false, error: 'License not found or inactive' });
    }

    const license = result.rows[0];

    // Update last validated timestamp
    await db.query(
      'UPDATE licenses SET last_validated_at = NOW() WHERE id = $1',
      [license.id]
    );

    // Activate if first time
    if (!license.activated_at) {
      await db.query('UPDATE licenses SET activated_at = NOW() WHERE id = $1', [license.id]);
    }

    res.json({
      valid: true,
      plan: license.plan,
      email: license.email,
      status: license.status,
    });
  } catch (e) {
    console.error('Validate error:', e);
    res.status(500).json({ valid: false, error: 'Server error' });
  }
});

// Manual license creation (for testing or manual grants)
app.post('/admin/create-license', async (req, res) => {
  const { secret, email, plan } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  if (!email || !['pro', 'station'].includes(plan)) return res.status(400).json({ error: 'Invalid params' });

  try {
    const key = generateLicenseKey(plan);
    await db.query(
      'INSERT INTO licenses (license_key, email, plan) VALUES ($1, $2, $3)',
      [key, email.toLowerCase(), plan]
    );
    await sendLicenseEmail(email, key, plan);
    res.json({ success: true, license_key: key, email, plan });
  } catch (e) {
    console.error('Create license error:', e);
    res.status(500).json({ error: String(e) });
  }
});

// List licenses (admin)
app.get('/admin/licenses', async (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const result = await db.query('SELECT * FROM licenses ORDER BY created_at DESC LIMIT 100');
  res.json(result.rows);
});

// ── Stripe Webhook ──
app.post('/webhooks/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('Webhook signature error:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  console.log('Stripe event:', event.type);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details?.email || session.customer_email;
    const customerId = session.customer;
    const subscriptionId = session.subscription;

    if (!email || !subscriptionId) {
      console.log('Missing email or subscription ID');
      return res.json({ received: true });
    }

    try {
      // Get subscription to find plan
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const priceId = subscription.items.data[0]?.price?.id;

      const plan = priceId === process.env.PRICE_PRO ? 'pro'
                 : priceId === process.env.PRICE_STATION ? 'station'
                 : null;

      if (!plan) {
        console.log('Unknown price ID:', priceId);
        return res.json({ received: true });
      }

      // Generate license key
      const licenseKey = generateLicenseKey(plan);

      // Save to DB
      await db.query(
        `INSERT INTO licenses (license_key, email, plan, stripe_customer_id, stripe_subscription_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (license_key) DO NOTHING`,
        [licenseKey, email.toLowerCase(), plan, customerId, subscriptionId]
      );

      // Send email
      await sendLicenseEmail(email, licenseKey, plan);

      console.log(`License created: ${licenseKey} for ${email} (${plan})`);
    } catch (e) {
      console.error('License creation error:', e);
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    await db.query(
      'UPDATE licenses SET status = $1 WHERE stripe_subscription_id = $2',
      ['cancelled', subscription.id]
    );
    console.log('Subscription cancelled:', subscription.id);
  }

  if (event.type === 'customer.subscription.updated') {
    const subscription = event.data.object;
    const status = subscription.status === 'active' ? 'active' : 'expired';
    await db.query(
      'UPDATE licenses SET status = $1 WHERE stripe_subscription_id = $2',
      [status, subscription.id]
    );
  }

  res.json({ received: true });
});

// ── Start ──
const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => console.log(`Ether API running on port ${PORT}`));
});
