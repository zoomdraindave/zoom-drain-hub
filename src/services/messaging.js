/**
 * Messaging Utility
 * ==================
 * Dual-channel message sender for the Zoom Drain Hub.
 *
 * Internal messages (to Dave) → WhatsApp
 * External messages (to restaurants) → SMS
 *
 * Both use the same Twilio API with different address prefixes.
 * Link stripping is applied to SMS only (A2P compliance).
 */

import twilio from 'twilio';

let client = null;

function getClient() {
  if (!client) {
    client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return client;
}

/**
 * Strip URLs from text for A2P SMS compliance.
 */
function stripLinks(text) {
  return text
    .replace(/https?:\/\/[^\s,)]+/gi, '[link removed]')
    .replace(/www\.[^\s,)]+/gi, '[link removed]')
    .replace(/\b[\w-]+\.(com|org|net|io|co|us|biz|info)\b[^\s,)]*/gi, '[link removed]')
    .replace(/(\[link removed\]\s*){2,}/g, '[link removed] ')
    .trim();
}

/**
 * Send a WhatsApp message to Dave (internal notifications).
 * No link stripping — WhatsApp has no A2P restrictions.
 * Falls back to SMS if WhatsApp is not configured.
 */
export async function sendInternalMessage(body, options = {}) {
  const to = process.env.YOUR_PHONE_NUMBER;
  if (!to) throw new Error('YOUR_PHONE_NUMBER not set');

  const whatsappFrom = process.env.TWILIO_WHATSAPP_NUMBER;
  const smsFrom = process.env.TWILIO_PHONE_NUMBER;

  const params = {
    body,
    ...options,
  };

  if (whatsappFrom) {
    // Send via WhatsApp
    params.to = `whatsapp:${to}`;
    params.from = whatsappFrom.startsWith('whatsapp:') ? whatsappFrom : `whatsapp:${whatsappFrom}`;
  } else {
    // Fallback to SMS
    params.to = to;
    params.from = smsFrom;
    params.body = stripLinks(body);
  }

  return getClient().messages.create(params);
}

/**
 * Send an SMS to an external number (restaurant-facing).
 * Link stripping applied for A2P compliance.
 */
export async function sendExternalSms(to, body) {
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!from) throw new Error('TWILIO_PHONE_NUMBER not set');

  return getClient().messages.create({
    body: stripLinks(body),
    to,
    from,
  });
}

/**
 * Send a WhatsApp message with quick-reply buttons.
 * Only works within a 24-hour session window or with approved templates.
 *
 * @param {string} body - Message text
 * @param {Array<{id: string, title: string}>} buttons - Up to 3 quick-reply buttons
 */
export async function sendInternalWithButtons(body, buttons = []) {
  const to = process.env.YOUR_PHONE_NUMBER;
  const whatsappFrom = process.env.TWILIO_WHATSAPP_NUMBER;

  if (!whatsappFrom || buttons.length === 0) {
    // No WhatsApp or no buttons — fall back to plain message
    return sendInternalMessage(body);
  }

  // Use Twilio Content API for interactive messages
  // For now, append button instructions as text (works in sandbox + production)
  const buttonText = buttons.map(b => `→ Reply "${b.title}"`).join('\n');
  return sendInternalMessage(`${body}\n\n${buttonText}`);
}

/**
 * Determine if a Twilio webhook is from WhatsApp or SMS.
 */
export function isWhatsAppMessage(req) {
  const from = req.body?.From || '';
  return from.startsWith('whatsapp:');
}

/**
 * Get the clean phone number from a Twilio webhook (strip whatsapp: prefix).
 */
export function getCleanNumber(twilioNumber) {
  return (twilioNumber || '').replace('whatsapp:', '');
}
