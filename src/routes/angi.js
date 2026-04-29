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

function validateSecret(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.ANGI_API_KEY) {
    console.warn(`Rejected webhook — invalid API key from ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Normalize Angi's payload into a consistent internal format
function normalizeLead(raw) {
  return {
    // Use srOid as primary ID, fall back to leadOid or generated
    id: String(raw.srOid || raw.leadOid || `lead-${Date.now()}`),
    leadOid: raw.leadOid,
    srOid: raw.srOid,

    contact: {
      name: raw.name || `${raw.firstName || ''} ${raw.lastName || ''}`.trim(),
      firstName: raw.firstName,
      lastName: raw.lastName,
      phone: raw.primaryPhone,
      secondaryPhone: raw.secondaryPhone,
      email: raw.email,
    },

    job: {
      type: raw.taskName,
      description: raw.comments,
      address: raw.address,
      city: raw.city,
      state: raw.stateProvince,
      zip: raw.postalCode,
      fullAddress: [raw.address, raw.city, raw.stateProvince, raw.postalCode]
        .filter(Boolean).join(', '),
    },

    interview: raw.interview || [],
    matchType: raw.matchType,
    leadSource: raw.leadSource,
    leadDescription: raw.leadDescription,
    fee: raw.fee,
    automatedContactCompliant: raw.automatedContactCompliant,
    trustedFormUrl: raw.trustedFormUrl,
    spCompanyName: raw.spCompanyName,
    received_at: new Date().toISOString(),
    raw: raw, // preserve original for database storage
  };
}

async function processLead(rawLead) {
  const lead = normalizeLead(rawLead);
  console.log(`Processing lead ${lead.id} — ${lead.contact.name} — ${lead.job.type}`);

  const analysis = await analyzeLead(lead);
  console.log(`Lead scored: ${analysis.score}/10, urgency: ${analysis.urgency}`);

  // Persist to database immediately
  await createLead(lead, analysis);
  console.log(`Lead ${lead.id} saved to database`);

  const urgencyLabel = analysis.urgency === 'emergency'
    ? 'EMERGENCY.'
    : `${analysis.urgency} priority.`;

  const speechText = `
    New Angi lead. ${urgencyLabel}
    ${analysis.phone_summary}
    Job type: ${analysis.job_type}. Estimated value: ${analysis.estimated_value}.
    Press 1 to connect to the customer now.
    Press 2 to receive a text summary instead.
    Hang up to skip this lead.
  `;

  const twiml = buildCallTwiml(speechText);
  console.log('TwiML being sent:', twiml); // temporary debug
  const call = await twilioClient.calls.create({
    twiml,
    to: process.env.YOUR_PHONE_NUMBER,
    from: process.env.TWILIO_PHONE_NUMBER,
    statusCallback: `${process.env.SERVER_URL}/twilio/status`,
    statusCallbackMethod: 'POST',
  });

  // Update lead with call SID
  await updateLeadCall(lead.id, call.sid);

  // Also keep in-memory store for fast keypress lookup
  saveLead(call.sid, {
    lead,
    analysis,
    customerPhone: lead.contact.phone,
  });

  console.log(`Call initiated: ${call.sid}`);
}

function buildCallTwiml(speechText) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="${process.env.SERVER_URL}/twilio/gather" method="POST" timeout="15">
    <Say voice="Polly.Joanna-Neural" rate="fast">${speechText}</Say>
  </Gather>
  <Say voice="Polly.Joanna-Neural" rate="fast">No response received. Lead has been logged.</Say>
</Response>`;
}

// Real Angi webhook
router.post('/angi', webhookLimiter, validateSecret, async (req, res) => {
  res.sendStatus(200);
  try {
    await processLead(req.body);
  } catch (err) {
    console.error('Lead processing error:', err);
  }
});

// Test endpoint — mirrors real Angi payload structure exactly
router.post('/angi/test', testLimiter, validateSecret, async (req, res) => {
  const mockLead = {
    name: 'John Smith',
    firstName: 'John',
    lastName: 'Smith',
    address: '4521 E Camelback Rd',
    city: 'Phoenix',
    stateProvince: 'AZ',
    postalCode: '85018',
    primaryPhone: process.env.YOUR_PHONE_NUMBER?.replace('+1', '') || '6025551234',
    secondaryPhone: null,
    email: 'john@example.com',
    srOid: Date.now(),
    leadOid: Date.now() + 1,
    fee: 0.0,
    taskName: 'Drain Cleaning - Clear Blockage',
    comments: 'Kitchen sink is completely backed up, standing water. Has been like this for 2 days. Tried plunging but no luck.',
    matchType: 'Lead',
    leadDescription: 'Standard',
    leadSource: 'AngiesList',
    interview: [
      { question: 'What type of drain needs cleaning?', answer: 'Kitchen sink' },
      { question: 'Is the drain completely blocked?', answer: 'Yes, completely blocked' },
      { question: 'When do you need this done?', answer: 'As soon as possible' },
    ],
    automatedContactCompliant: true,
    // Allow overrides from request body
    ...req.body,
  };

  try {
    await processLead(mockLead);
    res.json({
      status: 'ok',
      message: 'Test lead fired — your phone should ring shortly',
      leadId: String(mockLead.srOid),
    });
  } catch (err) {
    console.error('Test lead error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

export default router;