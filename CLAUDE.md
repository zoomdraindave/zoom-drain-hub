# Zoom Drain Hub

> **Read `soul-file-dave-winterbourne-zoom-drain.md` for full business context** — who Dave is, the target customer segments, competitive differentiators, and the strategic principles that should guide all decisions in this project.

AI-powered speed-to-lead system for a drain/plumbing service business (Phoenix East Valley). Receives webhooks from Angi and Thumbtack, analyzes leads with Claude AI, calls the owner with a voice summary, and enables one-keypress connection to the customer.

Also includes a restaurant prospect discovery and follow-up engine that uses Google Places + LACRM.

## Stack

- **Node.js 18+** with ES modules (`import`/`export`, no transpilation)
- **Express 5** for HTTP routing
- **Twilio** for voice calls and SMS
- **Anthropic Claude** (claude-sonnet-4-5) for lead analysis
- **PostgreSQL** (via Railway) for lead persistence
- **LACRM** for restaurant prospect CRM
- **Google Places API** for restaurant discovery

## Commands

```bash
npm run dev     # Start with hot reload (nodemon), port 3000
npm start       # Production start
```

No automated test suite. Use the test webhook endpoints:
- `POST /webhooks/angi/test` — fire a mock Angi lead
- `POST /webhooks/thumbtack/test` — fire a mock Thumbtack lead
- `GET /status` — verify env vars (masked), confirm config
- `GET /leads?key=YOUR_ANGI_API_KEY` — view recent leads dashboard

Shell scripts `test_angi_request.sh` and `test_thumbtack_request.sh` available for curl testing.

## Project Structure

```
src/
  server.js                  # Express app, middleware, route registration, DB init
  routes/
    angi.js                  # POST /webhooks/angi — lead receiver & call initiator
    thumbtack.js             # POST /webhooks/thumbtack — same flow as Angi
    twilio.js                # POST /twilio/gather (keypress), /twilio/status (call status)
    health.js                # GET / (health), /status, /leads dashboard
    restaurants.js           # Restaurant discovery/import/enrichment
    restaurantFollowup.js    # LACRM webhook handler, follow-up automation
    restaurantCommands.js    # Admin commands for restaurant workflow testing
  services/
    analyzeLead.js           # Claude AI — scoring, summarization, urgency flags
    database.js              # PostgreSQL pool, schema init, leads & call_events CRUD
    leadStore.js             # In-memory Map (CallSid → lead data, 10min TTL)
    googlePlaces.js          # Places search, deduplication, ICP scoring
    lacrmClient.js           # LACRM API wrapper
    restaurantDb.js          # PostgreSQL schema for restaurant follow-up state
    messaging.js             # SMS utilities
  middleware/
    rateLimiter.js           # 10 req/min live webhooks, 5/min test endpoints
  public/                    # privacy-policy.html, terms.html (10DLC), logo
```

## Key Patterns

**Async webhook handling** — endpoints return 200/202 immediately; all processing runs in the background via `setImmediate()` to avoid timeouts.

**Lead normalization** — `normalizeLead()` in each route converts platform-specific payloads into a consistent internal format before calling `analyzeLead()`.

**In-memory call bridging** — `leadStore.js` caches lead data by `CallSid` so `/twilio/gather` can look up the customer phone number without a DB hit.

**TwiML** — use `<Gather>` wrapping `<Say>` for barge-in keypresses. Use `voice="Polly.Joanna-Neural"` with `rate="fast"`. Do NOT use SSML `<prosody>` tags — they break Polly Neural voices on Twilio.

**Claude prompting** — single-turn prompt expecting raw JSON. Parser strips markdown fences if present. Graceful fallback if JSON parse fails.

**Subdomain redirects** — hardcoded in `server.js` middleware (not Namecheap URL redirects, which break SSL).

## Environment Variables

See `.env.example` for the full list. Critical notes:
- `TWILIO_AUTH_TOKEN` is the Auth Token (32-char hex), NOT an API Key Secret
- Generate webhook API keys with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `DATABASE_URL` is auto-injected by Railway — do not set manually
- `SERVER_URL` must have no trailing slash

## Deployment

Hosted on Railway. Push to `main` → auto-deploy. Railway provides PostgreSQL and injects `DATABASE_URL`. Custom domain via CNAME + Railway's Let's Encrypt SSL.
