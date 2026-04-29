import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { initDatabase } from './services/database.js';
import healthRouter from './routes/health.js';
import angiRouter from './routes/angi.js';
import twilioRouter from './routes/twilio.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1); // Trust Railway's reverse proxy

const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(join(__dirname, 'public')));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Subdomain redirects
app.use((req, res, next) => {
  if (req.hostname === 'golf.zoomdrain-phxev.com') {
    return res.redirect(301, 'https://www.zoomdrain.com/phoenix-east-valley/');
  }
  next();
});

app.use('/', healthRouter);
app.use('/webhooks', angiRouter);
app.use('/twilio', twilioRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found', path: req.path });
});

// Initialize database then start server
initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Zoom Drain Hub running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });