# Zoom Drain Hub

An AI-powered speed-to-lead automation system for drain and plumbing service businesses. When a new lead arrives from Angi's, the system instantly analyzes it with Claude AI, calls you with a spoken summary, and connects you directly to the customer the moment you press 1 — all within seconds of the lead arriving.

---

## How It Works

```
Angi's lead arrives
       ↓
Webhook received by your server
       ↓
Claude AI scores and summarizes the lead
       ↓
Twilio calls your phone and reads the summary
       ↓
Press 1 → customer is called and you're bridged
Press 2 → SMS summary sent to your phone
Hang up → lead is logged and skipped
       ↓
Lead status saved to PostgreSQL database
```

---

## Features

- **Instant lead notification** — your phone rings within seconds of a lead arriving
- **AI-powered briefing** — Claude summarizes the job, scores urgency 1–10, and estimates job value
- **One-press connection** — press 1 at any point during the summary to connect immediately
- **SMS fallback** — press 2 to receive a full lead summary by text instead
- **Permanent lead log** — every lead, call outcome, and status is stored in PostgreSQL
- **Secure webhook** — API key validation and rate limiting protect against abuse
- **Custom domain** — serve privacy policy, terms, and redirects from your own domain
- **Business hours aware** — architecture supports after-hours queueing (see Enhancements)

---

## Third-Party Services Required

| Service | Purpose | Cost |
|---|---|---|
| [Anthropic](https://console.anthropic.com) | Claude AI for lead analysis | Pay per use (~$0.003/lead) |
| [Twilio](https://twilio.com) | Voice calls and SMS | Pay per use (~$0.014/min) |
| [Railway](https://railway.app) | Server hosting and PostgreSQL | ~$5/month |
| [GitHub](https://github.com) | Code repository and deployment trigger | Free |
| [Namecheap](https://namecheap.com) | Custom domain (optional) | ~$15/year |
| [Angi's Pro](https://pro.angi.com) | Lead source with webhook delivery | Your existing account |

---

## Prerequisites

Before you begin, make sure you have the following installed locally:

- [Node.js](https://nodejs.org) v18 or higher
- [Git](https://git-scm.com)
- A terminal / command line

---

## Part 1: Account Setup

### 1.1 Anthropic API Key

1. Go to [console.anthropic.com](https://console.anthropic.com) and create an account
2. Navigate to **API Keys** → **Create Key**
3. Copy the key — it starts with `sk-ant-`
4. Add billing information under **Plans & Billing**

### 1.2 Twilio Account

1. Sign up at [twilio.com](https://twilio.com)
2. From the **Account Info** section on the dashboard, note your:
   - **Account SID** — starts with `AC`
   - **Auth Token** — click the eye icon to reveal it
3. Purchase a phone number:
   - Go to **Phone Numbers → Manage → Buy a Number**
   - Filter by **Voice** and **SMS** capabilities
   - Choose a local area code number for better answer rates
   - Note the number in E.164 format (e.g. `+16025551234`)
4. Set up a Messaging Service:
   - Go to **Messaging → Services → Create Messaging Service**
   - Name it (e.g. "Zoom Drain Customer Care"), use case: "Notify my users"
   - Go to **Sender Pool** → **Add Senders** → select your phone number
   - Note the **Messaging Service SID** — starts with `MG`
5. Configure your phone number for voice:
   - Go to **Phone Numbers → Active Numbers → click your number**
   - Under **Voice & Fax**, set "A call comes in" to **Webhook**
   - Leave the URL blank for now — you'll fill it in after deployment

### 1.3 10DLC Registration (Required for SMS)

SMS to customers requires carrier registration. Without it, messages will be filtered.

1. In Twilio Console → **Messaging → Regulatory Compliance**
2. Register your **Brand** (your business information)
3. Register a **Campaign** — use case: "Low Volume Mixed" or "Transactional"
4. You'll need to provide:
   - Privacy Policy URL: `https://www.yourdomain.com/privacy-policy.html`
   - Terms & Conditions URL: `https://www.yourdomain.com/terms.html`
   - Both pages are included in this project under `src/public/`

> **Note:** 10DLC registration takes 24–48 hours for carrier approval. SMS to your own phone number works immediately regardless.

### 1.4 Railway Account

1. Sign up at [railway.app](https://railway.app)
2. Connect your GitHub account when prompted
3. Start with the **Hobby plan** ($5/month) — sufficient for this application

### 1.5 GitHub Account

1. Sign up at [github.com](https://github.com)
2. Create a new **private** repository named `zoom-drain-hub`
3. Set up SSH authentication to avoid password prompts on every push:
   ```bash
   ssh-keygen -t ed25519 -C "your@email.com"
   cat ~/.ssh/id_ed25519.pub
   ```
   Copy the output and add it at **github.com → Settings → SSH and GPG Keys → New SSH key**

---

## Part 2: Local Setup

### 2.1 Clone or initialize the repository

If cloning an existing repo:
```bash
git clone git@github.com:YOUR_USERNAME/zoom-drain-hub.git
cd zoom-drain-hub
```

If starting fresh:
```bash
mkdir zoom-drain-hub && cd zoom-drain-hub
git init
git remote add origin git@github.com:YOUR_USERNAME/zoom-drain-hub.git
```

### 2.2 Install dependencies

```bash
npm install
```

### 2.3 Create your environment file

```bash
cp .env.example .env
```

Edit `.env` and fill in your values:

```env
PORT=3000
NODE_ENV=development

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Twilio
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+16025551234
YOUR_PHONE_NUMBER=+16025559999
MESSAGING_SERVICE_SID=MG...

# Security
ANGI_API_KEY=your-generated-secret

# Server
SERVER_URL=http://localhost:3000

# Database
DATABASE_URL=postgresql://localhost:5432/zoomdrain
```

**Generate a strong API key:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 2.4 Project structure

```
zoom-drain-hub/
├── src/
│   ├── routes/
│   │   ├── health.js        # Status, leads dashboard, /golf redirect
│   │   ├── angi.js          # Angi's webhook receiver and lead processor
│   │   └── twilio.js        # Call keypress handler and status callbacks
│   ├── services/
│   │   ├── analyzeLead.js   # Claude AI lead analysis
│   │   ├── leadStore.js     # In-memory store for active calls
│   │   └── database.js      # PostgreSQL operations
│   ├── middleware/
│   │   └── rateLimiter.js   # Rate limiting for webhook endpoints
│   ├── public/
│   │   ├── privacy-policy.html
│   │   ├── terms.html
│   │   └── zoom-drain-logo.png
│   └── server.js            # Express app entry point
├── .env                     # Local environment variables (never committed)
├── .env.example             # Template — safe to commit
├── .gitignore
├── package.json
└── README.md
```

### 2.5 Run locally

```bash
npm run dev
```

You should see:
```
Database initialized
Zoom Drain Hub running on port 3000
```

Test the health check:
```bash
curl http://localhost:3000/
```

---

## Part 3: Deploy to Railway

### 3.1 Push your code to GitHub

```bash
git add .
git commit -m "Initial commit"
git push -u origin main
```

### 3.2 Create Railway project

1. Go to [railway.app](https://railway.app) → **New Project**
2. Select **Deploy from GitHub repo**
3. Select your `zoom-drain-hub` repository
4. Railway detects Node.js and begins deploying automatically

### 3.3 Add PostgreSQL database

1. In your Railway project dashboard, click **+ New**
2. Select **Database → Add PostgreSQL**
3. Railway creates the database and automatically injects `DATABASE_URL` into your app service

### 3.4 Configure environment variables

Go to your app service → **Variables** tab and add all of the following:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `TWILIO_ACCOUNT_SID` | From Twilio dashboard |
| `TWILIO_AUTH_TOKEN` | From Twilio dashboard |
| `TWILIO_PHONE_NUMBER` | E.164 format: `+16025551234` |
| `YOUR_PHONE_NUMBER` | Your cell in E.164 format: `+16025559999` |
| `MESSAGING_SERVICE_SID` | Starts with `MG` |
| `ANGI_API_KEY` | Your generated secret |
| `SERVER_URL` | `https://your-app.up.railway.app` (update after adding custom domain) |
| `NODE_ENV` | `production` |

> `DATABASE_URL` is injected automatically by Railway — do not add it manually.

### 3.5 Verify deployment

Once deployed, hit your status endpoint:

```bash
curl https://your-app.up.railway.app/status
```

All variables should show `✓` with masked values. If any show `✗ missing`, add them in Railway's Variables tab.

---

## Part 4: Custom Domain (Optional)

### 4.1 Add domain in Railway

1. Your app service → **Settings → Networking → Custom Domain**
2. Add `www.yourdomain.com`
3. Railway shows you the CNAME value to use

### 4.2 Configure DNS in Namecheap

Go to **Advanced DNS** and add:

| Type | Host | Value |
|---|---|---|
| CNAME | www | your-app.up.railway.app |

### 4.3 Wait for SSL certificate

Railway automatically provisions an SSL certificate via Let's Encrypt. Watch the domain status in Railway's networking settings — it will change from **Waiting for DNS** to **Active** once complete (typically 5–15 minutes after DNS propagates).

### 4.4 Update SERVER_URL

Once your domain is active, update in Railway variables:
```
SERVER_URL=https://www.yourdomain.com
```

---

## Part 5: Twilio Final Configuration

Once you have your live `SERVER_URL`, go back to Twilio:

**Phone Numbers → Active Numbers → your number → Voice & Fax:**
- Set "A call comes in" → Webhook → `https://www.yourdomain.com/twilio/gather`
- Method: HTTP POST

---

## Part 6: Connect Angi's Webhook

Email `crmintegrations@angi.com` with:
- Your **SPID** (Company ID from your Angi's Pro account URL)
- Your webhook endpoint: `https://www.yourdomain.com/webhooks/angi`
- Request they include the header: `x-api-key: your-ANGI_API_KEY-value`

Alternatively, contact your Angi's account representative directly.

---

## Part 7: End-to-End Testing

### 7.1 Test the full call flow

```bash
curl -X POST "https://www.yourdomain.com/webhooks/angi/test" \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_ANGI_API_KEY" \
  -d '{"contact": {"name": "Test Customer", "phone": "YOUR_REAL_CELL_NUMBER"}}'
```

Your phone should ring within 5–8 seconds. You'll hear Claude's AI-generated lead summary. Press:
- **1** to bridge to the customer number you passed in
- **2** to receive an SMS summary
- **Hang up** to skip and log

### 7.2 Check your lead log

```bash
curl "https://www.yourdomain.com/leads?key=YOUR_ANGI_API_KEY"
```

You should see the test lead with its status recorded.

### 7.3 Verify TwiML

```bash
curl https://www.yourdomain.com/twilio/twiml-test
```

Returns sample TwiML XML — paste into Twilio's TwiML Bin tester to preview the voice.

---

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Claude AI API key from console.anthropic.com |
| `TWILIO_ACCOUNT_SID` | ✅ | Twilio Account SID starting with AC |
| `TWILIO_AUTH_TOKEN` | ✅ | Twilio Auth Token (32-char hex string) |
| `TWILIO_PHONE_NUMBER` | ✅ | Your Twilio number in E.164 format |
| `YOUR_PHONE_NUMBER` | ✅ | Your personal cell in E.164 format |
| `MESSAGING_SERVICE_SID` | ✅ | Twilio Messaging Service SID starting with MG |
| `ANGI_API_KEY` | ✅ | Secret key for webhook authentication |
| `SERVER_URL` | ✅ | Your public URL with no trailing slash |
| `DATABASE_URL` | ✅ | PostgreSQL connection string (auto-set by Railway) |
| `NODE_ENV` | ✅ | Set to `production` on Railway |
| `PORT` | ❌ | Defaults to 3000, auto-set by Railway |

---

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/` | None | Health check |
| `GET` | `/status` | None | Config status with masked values |
| `GET` | `/leads` | x-api-key | Recent leads dashboard |
| `POST` | `/webhooks/angi` | x-api-key | Live Angi's webhook receiver |
| `POST` | `/webhooks/angi/test` | x-api-key | Test endpoint with mock lead |
| `POST` | `/twilio/gather` | None | Twilio keypress callback |
| `POST` | `/twilio/status` | None | Twilio call status callback |
| `GET` | `/twilio/twiml-test` | None | Preview TwiML voice script |
| `GET` | `/privacy-policy.html` | None | Privacy policy (required for 10DLC) |
| `GET` | `/terms.html` | None | Terms & conditions (required for 10DLC) |
| `GET` | `/golf` | None | Custom subdomain redirect example |

---

## Lead Status Lifecycle

| Status | Meaning |
|---|---|
| `new` | Lead received, call being initiated |
| `called` | Your phone has been dialed |
| `connected` | You pressed 1 and were bridged to the customer |
| `sms_sent` | You pressed 2 and received a text summary |
| `skipped` | You hung up without pressing a key |

---

## Customizing the AI Prompt

The Claude prompt in `src/services/analyzeLead.js` controls how leads are scored and summarized. Key fields you can tune:

- **`phone_summary`** — adjust word count for shorter/longer briefings
- **`estimated_value`** — Claude infers this from job description; you can provide price ranges in the prompt
- **`flags`** — add custom flags relevant to your business (e.g. `"repeat_customer"`, `"commercial"`)
- **Urgency logic** — add examples in the prompt to calibrate scoring for your market

---

## Enhancements Roadmap

These features are not included but are natural next steps:

**Missed-call SMS to customers**
When you don't answer or skip a lead, automatically send a personalized SMS to the customer. Add to the `/twilio/status` handler when `CallStatus === 'no-answer'`.

**Business hours routing**
Non-emergency leads that arrive after hours get queued for a morning callback rather than calling you at 2am. Check the current time in `processLead` before firing the Twilio call.

**Multi-tech cascade**
If you don't answer within 20 seconds, automatically call a second technician. Use Twilio's `timeout` parameter on `<Dial>` and chain calls via status webhooks.

**Lead analytics dashboard**
Build a simple HTML dashboard served at `/dashboard` showing win rate by job type, average response time, and revenue by lead source using the data already stored in PostgreSQL.

**CRM integration**
After a successful connection, POST lead details to your CRM (ServiceTitan, Jobber, Housecall Pro, etc.) using their API.

---

## Security Notes

- **Never commit `.env`** — it's in `.gitignore` by default
- **Rotate `ANGI_API_KEY` periodically** — generate a new one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- **Keep Railway private** — your service should be set to private in Railway's networking settings except for the explicitly exposed port
- **Rate limiting** is configured at 10 requests/minute for the webhook and 5/minute for the test endpoint
- **SSL is enforced** — Railway provisions Let's Encrypt certificates automatically

---

## Troubleshooting

**Phone never rings after test**
- Check Railway logs for errors after `Processing lead...`
- Verify `TWILIO_PHONE_NUMBER` and `YOUR_PHONE_NUMBER` are in E.164 format with `+1` prefix
- Confirm `TWILIO_AUTH_TOKEN` is the Auth Token (not an API Key Secret)

**Press 1 or 2 gives an error**
- Check that `SERVER_URL` matches your live domain exactly, no trailing slash
- Verify `/twilio/gather` appears in Railway logs when you press a key — if not, `SERVER_URL` is wrong
- Check Twilio Console → Monitor → Errors for specific TwiML errors

**Claude returns urgency: unknown**
- Claude occasionally wraps JSON in markdown code fences — the parser strips these automatically
- Check Railway logs for `Claude response was not valid JSON:` followed by the raw response

**SSL certificate stuck on "Validating challenges"**
- Use `www.yourdomain.com` instead of the root domain — root domain CNAME has DNS spec issues
- Verify DNS propagation at [dnschecker.org](https://dnschecker.org) before retrying

**Database connection error on startup**
- Confirm `DATABASE_URL` is present in your app service variables (not just the Postgres service)
- Railway injects it automatically when both services are in the same project

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

## Contributing

This project was built to help small service businesses compete on speed-to-lead. If you adapt it for another industry or add features, pull requests are welcome.
