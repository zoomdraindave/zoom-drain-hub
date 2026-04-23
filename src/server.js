import express from 'express';
import 'dotenv/config';
import healthRouter from './routes/health.js';
import angiRouter from './routes/angi.js';
import twilioRouter from './routes/twilio.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Parse both JSON and URL-encoded bodies
// (Twilio sends form-encoded, Angi sends JSON)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logger — shows every hit in your Railway logs
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Routes
app.use('/', healthRouter);
app.use('/webhooks', angiRouter);
app.use('/twilio', twilioRouter);

// Catch-all for unknown routes
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found', path: req.path });
});

app.listen(PORT, () => {
  console.log(`Zoom Drain Hub running on port ${PORT}`);
});
