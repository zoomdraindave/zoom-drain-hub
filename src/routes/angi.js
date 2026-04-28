import { Router } from 'express';
import twilio from 'twilio';
import { analyzeLead } from '../services/analyzeLead.js';
import { saveLead } from '../services/leadStore.js';
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

async function processLead(lead) {
  console.log(`Processing lead ${lead.id}...`);

  const analysis = await analyzeLead(lead);
  console.log(`Lead scored: ${analysis.score}/10, urgency: ${analysis.urgency}`);

  const urgencyLabel = analysis.urgency === 'emergency' ? 'EMERGENCY.' : `${analysis.urgency} priority.`;
  const speechText = `
    New Angi lead. ${urgencyLabel}
    ${analysis.phone_summary}
    Job type: ${analysis.job_type}. Estimated value: ${analysis.estimated_value}.
    Press 1 to connect to the customer now.
    Press 2 to receive a text summary instead.
    Hang up to skip this lead.
  `;

  const call = await twilioClient.calls.create({
    twiml: buildCallTwiml(speechText),
    to: process.env.YOUR_PHONE_NUMBER,
    from: process.env.TWILIO_PHONE_NUMBER,
    statusCallback: `${process.env.SERVER_URL}/twilio/status`,
    statusCallbackMethod: 'POST',
  });

  saveLead(call.sid, {
    lead,
    analysis,
    customerPhone: lead.contact?.phone,
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

// Test endpoint
router.post('/angi/test', testLimiter, validateSecret, async (req, res) => {
  const mockLead = {
    id: 'test-' + Date.now(),
    contact: {
      name: req.body?.contact?.name || 'John Smith',
      phone: req.body?.contact?.phone || process.env.YOUR_PHONE_NUMBER,
      email: 'john@example.com',
    },
    job: {
      type: req.body?.job?.type || 'Drain Cleaning',
      description: req.body?.job?.description || 'Kitchen sink completely backed up, standing water. Has been like this for 2 days.',
      address: '4521 E Camelback Rd, Phoenix AZ 85018',
    },
    submitted_at: new Date().toISOString(),
    ...req.body,
  };

  try {
    await processLead(mockLead);
    res.json({ status: 'ok', message: 'Test lead fired — your phone should ring shortly', leadId: mockLead.id });
  } catch (err) {
    console.error('Test lead error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

export default router;