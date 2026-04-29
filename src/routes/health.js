import { Router } from 'express';
import { getRecentLeads } from '../services/database.js';

const router = Router();
router.get('/leads', async (req, res) => {
  // Simple auth — same webhook secret
  const secret = req.headers['x-api-key'] || req.query.key;
  if (secret !== process.env.ANGI_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const leads = await getRecentLeads(50);
  res.json({
    count: leads.length,
    leads: leads.map(l => ({
      id: l.id,
      received_at: l.received_at,
      customer: l.customer_name,
      phone: l.customer_phone,
      job_type: l.job_type,
      urgency: l.urgency,
      score: l.score,
      status: l.status,
      estimated_value: l.estimated_value,
      call_duration: l.call_duration,
    }))
  });
});

// Basic health check — Railway uses this to confirm your app is alive
router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Zoom Drain Automation Hub',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
  });
});

// Detailed status — useful for checking all systems at a glance
router.get('/status', (req, res) => {
  const vars = [
    'ANTHROPIC_API_KEY',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_PHONE_NUMBER',
    'YOUR_PHONE_NUMBER',
    'ANGI_API_KEY',
    'MESSAGING_SERVICE_SID',
    'SERVER_URL',
    'DATABASE_URL',
  ];

  const config = {};
  vars.forEach(v => {
    const val = process.env[v];
    if (!val) {
      config[v] = '✗ missing';
    } else {
      const last4 = val.slice(-4);
      const masked = '•'.repeat(Math.min(val.length - 4, 20));
      config[v] = `✓ ${masked}${last4}`;
    }
  });

  res.json({
    status: 'ok',
    environment: process.env.NODE_ENV || 'development',
    config,
  });
});

export default router;
