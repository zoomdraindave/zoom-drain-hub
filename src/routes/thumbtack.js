import { Router } from 'express';
import twilio from 'twilio';
import { analyzeLead } from '../services/analyzeLead.js';
import { saveLead } from '../services/leadStore.js';
import { createLead, updateLeadCall } from '../services/database.js';
import { webhookLimiter, testLimiter } from '../middleware/rateLimiter.js';

const router = Router();
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Thumbtack uses HMAC signature validation rather than a simple API key
// They send an X-Thumbtack-Signature header with each request
function validateThumbtackSignature(req, res, next) {
  // Simple API key check for now — update to HMAC once you have credentials
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.THUMBTACK_API_KEY) {
    console.warn(`Rejected Thumbtack webhook from ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Normalize Thumbtack's payload to the same internal format as Angi's
// NOTE: Update field mappings once you receive real payload examples from Thumbtack
function normalizeLead(raw) {
  // Thumbtack's negotiation/lead payload structure
  const customer = raw.customer || raw.contact || {};
  const request = raw.request || raw.service || {};

  return {
    id: String(raw.negotiationID || raw.leadID || raw.id || `tt-${Date.now()}`),

    contact: {
      name: customer.name || `${customer.firstName || ''} ${customer.lastName || ''}`.trim(),
      firstName: customer.firstName,
      lastName: customer.lastName,
      phone: customer.phone || customer.phoneNumber,
      email: customer.email,
    },

    job: {
      type: request.category || request.serviceType || raw.category,
      description: request.description || raw.description || raw.details,
      address: customer.address || raw.location?.address,
      city: customer.city || raw.location?.city,
      state: customer.state || raw.location?.state,
      zip: customer.zip || customer.zipCode || raw.location?.zipCode,
      fullAddress: [
        customer.address || raw.location?.address,
        customer.city || raw.location?.city,
        customer.state || raw.location?.state,
        customer.zip || raw.location?.zipCode,
      ].filter(Boolean).join(', '),
    },

    interview: raw.questions || raw.details?.questions || [],
    leadSource: 'Thumbtack',
    matchType: raw.matchType || 'Lead',
    received_at: new Date().toISOString(),
    raw,
  };
}

async function processLead(rawLead) {
  const lead = normalizeLead(rawLead);
  console.log(`[Thumbtack] Processing lead ${lead.id} — ${lead.contact.name} — ${lead.job.type}`);

  const analysis = await analyzeLead(lead);
  console.log(`[Thumbtack] Lead scored: ${analysis.score}/10, urgency: ${analysis.urgency}`);

  await createLead(lead, analysis);

  const call = await twilioClient.calls.create({
    twiml: buildCallTwiml(),
    to: process.env.YOUR_PHONE_NUMBER,
    from: process.env.TWILIO_PHONE_NUMBER,
    statusCallback: `${process.env.SERVER_URL}/twilio/status`,
    statusCallbackMethod: 'POST',
  });

  await updateLeadCall(lead.id, call.sid);

  saveLead(call.sid, {
    lead,
    analysis,
    customerPhone: lead.contact.phone,
  });

  console.log(`[Thumbtack] Call initiated: ${call.sid}`);
}

function buildCallTwiml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="${process.env.SERVER_URL}/twilio/answer-confirm" method="POST" timeout="30">
    <Say voice="Polly.Joanna-Neural" rate="fast">Zoom Drain. Press any key for lead details.</Say>
  </Gather>
</Response>`;
}

// Live Thumbtack webhook
router.post('/thumbtack', webhookLimiter, validateThumbtackSignature, async (req, res) => {
  console.log('[Thumbtack] Raw payload:', JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
  try {
    await processLead(req.body);
  } catch (err) {
    console.error('[Thumbtack] Lead processing error:', err);
  }
});

// Test endpoint
router.post('/thumbtack/test', testLimiter, validateThumbtackSignature, async (req, res) => {
  const mockLead = {
    negotiationID: `tt-test-${Date.now()}`,
    customer: {
      name: 'Sarah Johnson',
      firstName: 'Sarah',
      lastName: 'Johnson',
      phone: process.env.YOUR_PHONE_NUMBER?.replace('+1', '') || '6025551234',
      email: 'sarah@example.com',
      address: '3842 N 32nd Street',
      city: 'Phoenix',
      state: 'AZ',
      zip: '85018',
    },
    request: {
      category: 'Drain Cleaning',
      serviceType: 'Drain Cleaning - Clear Blockage',
      description: 'Kitchen sink and bathroom drain both clogged. Water draining very slowly. Need someone soon.',
    },
    questions: [
      { question: 'What type of drain needs cleaning?', answer: 'Kitchen and bathroom' },
      { question: 'How urgent is this?', answer: 'Urgent - needs to be done today or tomorrow' },
    ],
    ...req.body,
  };

  try {
    await processLead(mockLead);
    res.json({
      status: 'ok',
      message: 'Thumbtack test lead fired — your phone should ring shortly',
      leadId: mockLead.negotiationID,
    });
  } catch (err) {
    console.error('[Thumbtack] Test lead error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

export default router;