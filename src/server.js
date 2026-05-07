import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { initDatabase } from './services/database.js';
import healthRouter from './routes/health.js';
import angiRouter from './routes/angi.js';
import twilioRouter from './routes/twilio.js';
import restaurantRouter from './routes/restaurants.js';
import restaurantFollowupRouter, { startDigestCron } from './routes/restaurantFollowup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
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

// Routes
app.use('/', healthRouter);
app.use('/webhooks', angiRouter);
app.use('/twilio', twilioRouter);
// Follow-up router MUST come before restaurant router — the restaurant
// router has a blanket auth middleware that would block LACRM webhooks
app.use('/restaurants', restaurantFollowupRouter);
app.use('/restaurants', restaurantRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found', path: req.path });
});

// Initialize database then start server
initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Zoom Drain Hub running on port ${PORT}`);

      // Start the weekly digest cron
      startDigestCron();
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
