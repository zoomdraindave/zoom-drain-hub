import rateLimit from 'express-rate-limit';

// Webhook endpoint — Angi's sends at most a few leads per hour
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,      // 1 minute window
  max: 10,                   // max 10 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn(`Rate limit exceeded from ${req.ip}`);
    res.status(429).json({ error: 'Too many requests' });
  }
});

// Test endpoint — stricter, only you should be hitting this
export const testLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  handler: (req, res) => {
    console.warn(`Test rate limit exceeded from ${req.ip}`);
    res.status(429).json({ error: 'Too many requests' });
  }
});