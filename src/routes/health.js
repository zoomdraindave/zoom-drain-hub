import { Router } from 'express';

const router = Router();

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
    'WEBHOOK_SECRET',
  ];

  const config = {};
  vars.forEach(v => {
    config[v] = process.env[v] ? '✓ set' : '✗ missing';
  });

  res.json({
    status: 'ok',
    environment: process.env.NODE_ENV || 'development',
    config,
  });
});

export default router;
