import { Router }      from 'express';
import twilio          from 'twilio';
import rateLimit       from 'express-rate-limit';
import {
  getAsset, createAsset,
  isAuthorizedPhone, normalizePhone,
  createOtpSession, verifyOtp,
  createRegSession, verifyRegSession,
} from '../services/assetDb.js';
import {
  searchCustomers, getCustomerLocations,
  createEquipment, getServiceHistory,
} from '../services/serviceTitan.js';

const router = Router();

// ── Rate limiters ─────────────────────────────────────────────────────────────

const otpRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait 15 minutes and try again.' },
});

const otpVerifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,  // 10 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait 10 minutes and try again.' },
});

// ── Cookie helpers ────────────────────────────────────────────────────────────

// Cookie name is scoped to the asset ID so different assets don't share sessions
function cookieName(assetId) {
  return `zd_reg_${assetId}`;
}

function getSessionToken(req, assetId) {
  const cookieHeader = req.headers.cookie || '';
  const name  = cookieName(assetId);
  // Parse just the cookie we care about — no cookie-parser dependency needed
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([a-f0-9]{64})`));
  return match?.[1] || null;
}

function setSessionCookie(res, assetId, token) {
  const isProduction = process.env.NODE_ENV === 'production';
  const secure = isProduction ? 'Secure; ' : '';
  res.setHeader(
    'Set-Cookie',
    `${cookieName(assetId)}=${token}; HttpOnly; ${secure}Path=/asset/${assetId}; Max-Age=3600; SameSite=Strict`
  );
}

// ── GET /asset/:id — Serve the HTML shell ─────────────────────────────────────
//
// The page is a lightweight shell; all content is rendered by asset.js via
// fetch calls to the endpoints below. The scheduling widget script is injected
// here (server-side) so it loads once, reliably, without client-side injection.

router.get('/:id', (req, res) => {
  const { id } = req.params;

  const schedulingApiKey = process.env.ST_SCHEDULING_PRO_API_KEY || '';
  const schedulerId      = process.env.ST_SCHEDULER_ID           || '';
  const schedulingReady  = !!(schedulingApiKey && schedulerId);

  // Phone number for the fallback "Call to Schedule" link
  const displayPhone = process.env.YOUR_PHONE_NUMBER || '';

  const schedulingScript = schedulingReady
    ? `<script
        data-api-key="${schedulingApiKey}"
        data-schedulerid="${schedulerId}"
        data-auto-open="false"
        defer
        id="se-widget-embed"
        src="https://embed.scheduler.servicetitan.com/scheduler-v1.js">
       </script>`
    : '';

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store'); // always fresh
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#1B3D6E">
  <meta name="robots" content="noindex">
  <title>Zoom Drain — Equipment #${id}</title>
  <link rel="stylesheet" href="/asset.css">
</head>
<body>
  <div id="app"
       data-asset-id="${id}"
       data-scheduling-configured="${schedulingReady}"
       data-phone="${displayPhone}">
  </div>
  <script src="/asset.js"></script>
  ${schedulingScript}
</body>
</html>`);
});

// ── GET /asset/:id/data — Asset state (called by asset.js on load) ────────────

router.get('/:id/data', async (req, res) => {
  const { id } = req.params;
  try {
    const asset = await getAsset(id);

    if (asset) {
      const history = await getServiceHistory(asset.st_equipment_id || id).catch(err => {
        console.warn(`[asset/data] Service history fetch failed for #${id}:`, err.message);
        return [];
      });
      return res.json({
        assetId:  id,
        registered: true,
        asset,
        history,
        schedulingProConfigured: !!(process.env.ST_SCHEDULING_PRO_API_KEY && process.env.ST_SCHEDULER_ID),
      });
    }

    // Not registered — check if the requester has a valid registration session
    const token      = getSessionToken(req, id);
    const canRegister = token ? !!(await verifyRegSession(token, id)) : false;

    res.json({ assetId: id, registered: false, canRegister });
  } catch (err) {
    console.error('[asset/data]', err);
    res.status(500).json({ error: 'Could not load asset data.' });
  }
});

// ── POST /asset/:id/request-otp — Send a one-time code to the requester ───────

router.post('/:id/request-otp', otpRequestLimiter, async (req, res) => {
  const { id }   = req.params;
  const { phone } = req.body || {};

  if (!phone) return res.status(400).json({ error: 'Phone number is required.' });

  try {
    const authorized = await isAuthorizedPhone(phone);
    if (!authorized) {
      // Keep the error generic so we don't leak which numbers are enrolled
      return res.status(403).json({
        error: 'That number is not authorized. Contact your Zoom Drain administrator.',
      });
    }

    const otp      = await createOtpSession(phone, id);
    const client   = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const normalized = normalizePhone(phone);

    await client.messages.create({
      body: `Your Zoom Drain verification code is: ${otp}\n\nExpires in 10 minutes. Do not share this code.`,
      to:   normalized,
      from: process.env.TWILIO_PHONE_NUMBER,
    });

    console.log(`[asset] OTP sent for asset #${id} → ${normalized}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[asset/request-otp]', err);
    res.status(500).json({ error: 'Failed to send verification code. Please try again.' });
  }
});

// ── POST /asset/:id/verify-otp — Verify code and issue a session cookie ───────

router.post('/:id/verify-otp', otpVerifyLimiter, async (req, res) => {
  const { id } = req.params;
  const { phone, otp } = req.body || {};

  if (!phone || !otp) return res.status(400).json({ error: 'Phone and code are required.' });

  try {
    const valid = await verifyOtp(phone, String(otp).trim(), id);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid or expired verification code.' });
    }

    const token = await createRegSession(phone, id);
    setSessionCookie(res, id, token);
    console.log(`[asset] OTP verified for asset #${id} by ${normalizePhone(phone)}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[asset/verify-otp]', err);
    res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
});

// ── GET /asset/:id/customers — Customer autocomplete (requires session) ────────

router.get('/:id/customers', async (req, res) => {
  const { id } = req.params;
  const { q }  = req.query;

  const token = getSessionToken(req, id);
  if (!token || !(await verifyRegSession(token, id))) {
    return res.status(401).json({ error: 'Session expired. Please verify again.' });
  }

  if (!q || String(q).trim().length < 2) return res.json({ customers: [] });

  try {
    const customers = await searchCustomers(String(q).trim());
    res.json({ customers });
  } catch (err) {
    console.error('[asset/customers]', err);
    res.status(500).json({ error: 'Customer search failed.' });
  }
});

// ── GET /asset/:id/locations/:customerId — Customer locations (requires session)

router.get('/:id/locations/:customerId', async (req, res) => {
  const { id, customerId } = req.params;

  const token = getSessionToken(req, id);
  if (!token || !(await verifyRegSession(token, id))) {
    return res.status(401).json({ error: 'Session expired. Please verify again.' });
  }

  try {
    const locations = await getCustomerLocations(customerId);
    res.json({ locations });
  } catch (err) {
    console.error('[asset/locations]', err);
    res.status(500).json({ error: 'Failed to load locations.' });
  }
});

// ── POST /asset/:id/register — Save the asset record (requires session) ────────

router.post('/:id/register', async (req, res) => {
  const { id } = req.params;

  const token              = getSessionToken(req, id);
  const registeredByPhone  = token ? await verifyRegSession(token, id) : null;
  if (!registeredByPhone) {
    return res.status(401).json({ error: 'Session expired. Please verify your identity again.' });
  }

  const {
    asset_type, notes,
    customer_id, customer_name, customer_phone, customer_email,
    location_id, location_address, location_name,
  } = req.body || {};

  if (!asset_type)  return res.status(400).json({ error: 'Equipment type is required.' });
  if (!customer_id) return res.status(400).json({ error: 'Customer is required.' });

  try {
    // Create the equipment record in Service Titan.
    // If ST isn't configured yet this returns a mock ID and logs a warning — registration still proceeds.
    let stEquipmentId = null;
    try {
      const equip    = await createEquipment(id, asset_type, customer_id, location_id || '');
      stEquipmentId  = equip.id;
    } catch (stErr) {
      console.warn(`[asset/register] ST equipment creation failed (non-fatal):`, stErr.message);
    }

    const asset = await createAsset({
      id,
      asset_type,
      notes,
      customer_id,
      customer_name,
      customer_phone,
      customer_email,
      location_id,
      location_address,
      location_name,
      st_equipment_id:    stEquipmentId,
      registered_by_phone: registeredByPhone,
    });

    console.log(`[asset] Registered #${id} (${asset_type}) → ${customer_name} by ${registeredByPhone}`);
    res.json({ ok: true, asset });
  } catch (err) {
    console.error('[asset/register]', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

export default router;
