import { Router } from 'express';

const router = Router();

// Webhook secret validation middleware
function validateSecret(req, res, next) {
  const secret = req.headers['x-webhook-secret'] || req.query.secret;
  if (secret !== process.env.WEBHOOK_SECRET) {
    console.warn('Rejected webhook — invalid secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Real Angi webhook — this is what Angi's will POST to
router.post('/angi', validateSecret, async (req, res) => {
  // Always acknowledge immediately
  res.sendStatus(200);

  const lead = req.body;
  console.log('Angi lead received:', JSON.stringify(lead, null, 2));

  // TODO: wire in Claude + Twilio here (next phase)
  console.log('Lead queued for processing:', lead?.contact?.name || 'Unknown');
});

// Test endpoint — simulate an Angi lead without needing a real webhook
router.post('/angi/test', validateSecret, async (req, res) => {
  const mockLead = {
    id: 'test-' + Date.now(),
    contact: {
      name: 'John Smith',
      phone: '6025551234',
      email: 'john@example.com',
    },
    job: {
      type: 'Drain Cleaning',
      description: 'Kitchen sink is completely backed up, water not draining at all. Has been like this for 2 days.',
      address: '4521 E Camelback Rd, Phoenix AZ 85018',
    },
    submitted_at: new Date().toISOString(),
    // Override with anything from the request body
    ...req.body,
  };

  console.log('Test lead fired:', JSON.stringify(mockLead, null, 2));

  res.json({
    status: 'ok',
    message: 'Test lead processed — check your server logs',
    lead: mockLead,
  });
});

export default router;
