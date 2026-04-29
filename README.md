# Zoom Drain Hub

An AI-powered speed-to-lead automation system for drain and plumbing service businesses. When a new lead arrives from Angi's, the system instantly analyzes it with Claude AI, calls you with a spoken summary, and connects you directly to the customer the moment you press 1 — all within seconds of the lead arriving.

---

## How It Works

```
Angi's lead arrives via webhook
           ↓
Webhook received, validated, and normalized
           ↓
Claude AI scores urgency (1–10), summarizes job, estimates value
           ↓
Twilio calls your phone and reads the AI summary
           ↓
Press 1 → customer is called and you're bridged immediately
Press 2 → SMS summary sent to your phone
Hang up → lead is logged and skipped
           ↓
Lead status and call outcome saved to PostgreSQL
```

---

## Features

- **Instant lead notification** — your phone rings within seconds of a lead arriving
- **AI-powered briefing** — Claude analyzes job type, interview answers, urgency, and estimates job value
- **Barge-in keypresses** — press 1 or 2 at any point during the summary to act immediately
- **One-press connection** — press 1 to bridge directly to the customer
- **SMS fallback** — press 2 to receive a full lead summary by text
- **Permanent lead log** — every lead, call outcome, and status stored in PostgreSQL
- **Real Angi's payload support** — normalized to handle the actual Angi's webhook structure including interview Q&A
- **Secure webhook** — API key validation and rate limiting protect against abuse
- **Custom domain** — privacy policy, terms, and redirects served from your own domain
- **Subdomain redirects** — route subdomains (e.g. QR code links) to external URLs
- **10DLC compliant** — privacy policy and terms pages included and hosted

---

## Third-Party Services Required

| Service | Purpose | Cost |
|---|---|---|
| [Anthropic](https://console.anthropic.com) | Claude AI for lead analysis | Pay per use (~$0.003/lead) |
| [Twilio](https://twilio.com) | Voice calls and SMS | Pay per use (~$0.014/min) |
| [Railway](https://railway.app) | Server hosting and PostgreSQL | ~$5/month |
| [GitHub](https://github.com) | Code repository and auto-deployment | Free |
| [Namecheap](https://namecheap.com) | Custom domain | ~$15/year |
| [Angi's Pro](https://pro.angi.com) | Lead source with webhook delivery | Your existing account |

---

## Prerequisites

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
2. From the **Account Info** dashboard, note your:
   - **Account SID** — starts with `AC`
   - **Auth Token** — click the eye icon to reveal the 32-character hex string
3. Purchase a phone number:
   - Go to **Phone Numbers → Manage → Buy a Number**
   - Filter by **Voice** and **SMS** capabilities
   - Choose a local area code for better answer rates
   - Note the number in E.164 format (e.g. `+16025551234`)
4. Configure your phone number for voice:
   - Go to **Phone Numbers → Active Numbers → click your number**
   - Under **Voice & Fax**, set "A call comes in" → **Webhook** → `https://www.yourdomain.com/twilio/gather`
   - Method: **HTTP POST**
5. Set up a Messaging Service:
   - Go to **Messaging → Services → Create Messaging Service**
   - Name it (e.g. "Zoom Drain Customer Care"), use case: "Notify my users"
   - Integration setting: **Defer to sender's webhook**
   - Go to **Sender Pool** → **Add Senders** → select your phone number
   - Note the **Messaging Service SID** — starts with `MG`

### 1.3 Twilio Trust Hub (Reduces "Suspected Spam" Label)

1. In the Twilio Console top navigation → **Admin** → **Account Trust Hub**
2. Click **Create Primary Customer Profile** → **Business/Organization Profile**
3. Fill in your legal business name, address, and EIN
4. Add yourself as the authorized representative
5. Submit — approval typically takes 24 hours
6. Once approved, register for **STIR/SHAKEN attestation** to have calls signed as verified
7. Also register at [freecallerregistry.com](https://freecallerregistry.com) — this pushes your business name to AT&T, T-Mobile, and Verizon's spam databases and replaces "Suspected Spam" with your business name on recipient screens

### 1.4 10DLC Registration (Required for SMS to Customers)

SMS to customers requires carrier registration. Without it, messages will be filtered as spam.

1. In Twilio Console → **Messaging → Regulatory Compliance**
2. Register your **Brand** (business information)
3. Register a **Campaign** — use case: "Low Volume Mixed" or "Transactional"
4. You will need to provide:
   - **Privacy Policy URL**: `https://www.yourdomain.com/privacy-policy.html`
   - **Terms URL**: `https://www.yourdomain.com/terms.html`
   - **Opt-in description** — see guidance below
   - **Campaign description** — see guidance below
   - **Sample messages** — see guidance below

#### 10DLC Opt-In Description (use this exact language)

> End-users provide explicit consent to receive SMS messages at the point of service request submission. When a customer submits a drain or plumbing service request directly to [Your Business Name] — either through our website or via a third-party lead platform — they provide their phone number and agree to our Terms and Conditions, which explicitly state that by providing their phone number and submitting a service request they expressly consent to receive SMS text messages and phone calls from [Your Business Name] at the number provided, for the purpose of fulfilling their request.
>
> Our Terms and Conditions: https://www.yourdomain.com/terms.html
> Our Privacy Policy: https://www.yourdomain.com/privacy-policy.html
>
> SMS messages are strictly transactional — sent only in direct response to a service request initiated by the customer. Message frequency: 1–3 messages per service request.

#### 10DLC Campaign Description (use this exact language)

> This campaign sends transactional SMS messages to customers who have submitted a plumbing or drain service request and provided their phone number, expressly consenting to be contacted by [Your Business Name]. Messages are sent solely in direct response to a customer-initiated service request.
>
> The SMS workflow is as follows: when a service request is received, a representative attempts to call the customer immediately. If the customer cannot be reached by phone, a single SMS is sent to notify them that [Your Business Name] received their request and will follow up shortly. No marketing or promotional content is included. Messages are sent only to customers who initiated the service request and provided their phone number for the purpose of being contacted.
>
> Message frequency: 1–3 messages per service request. Opt-out: reply STOP. Help: reply HELP. Message and data rates may apply.

#### Sample Messages (provide all 5 to Twilio)

```
[Business]: We received your drain service request and just tried 
to reach you. We'll call back shortly. Reply STOP to opt out.

[Business]: Got your plumbing request. A tech will call you within 
the hour to discuss. Questions? Call (602) 555-0000. Msg rates apply.

[Business]: Your service appt is confirmed for tomorrow between 
10am-12pm. Call (602) 555-0000 to reschedule. Reply STOP to opt out.

[Business]: Your technician is on the way and will arrive in approx 
30 min. Call (602) 555-0000 with questions. Reply STOP to opt out.

[Business]: We tried reaching you about your drain request. 
Call (602) 555-0000 or we'll try again soon. Reply STOP to opt out.
```

> **Note:** 10DLC registration takes 24–48 hours for carrier approval after submission. If rejected, check error code 30896 — the most common cause is insufficient opt-in description detail.

### 1.5 Railway Account

1. Sign up at [railway.app](https://railway.app)
2. Connect your GitHub account when prompted
3. Start with the **Hobby plan** ($5/month)

### 1.6 GitHub Account

1. Sign up at [github.com](https://github.com) and create a **private** repository named `zoom-drain-hub`
2. Set up SSH authentication to avoid password prompts:
   ```bash
   ssh-keygen -t ed25519 -C "your@email.com"
   cat ~/.ssh/id_ed25519.pub
   ```
   Add the output at **github.com → Settings → SSH and GPG Keys → New SSH key**
3. Verify it works:
   ```bash
   ssh -T git@github.com
   # Should respond: Hi username! You've successfully authenticated.
   ```

### 1.7 Custom Domain (Namecheap)

1. Purchase your domain at [namecheap.com](https://namecheap.com)
2. Go to **Advanced DNS** and add:

| Type | Host | Value |
|---|---|---|
| CNAME | www | your-app.up.railway.app |
| URL Redirect | @ | https://www.yourdomain.com |

> **Important:** Use `www.yourdomain.com` rather than the root domain. Root domain CNAME records have DNS spec issues that cause SSL certificate validation failures with Railway. The `www` subdomain uses a standard CNAME with no ambiguity.

---

## Part 2: Local Setup

### 2.1 Clone the repository

```bash
git clone git@github.com:YOUR_USERNAME/zoom-drain-hub.git
cd zoom-drain-hub
```

### 2.2 Install dependencies

```bash
npm install
```

### 2.3 Create your environment file

```bash
cp .env.example .env
```

Edit `.env` with your values:

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

# Security — generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ANGI_API_KEY=your-generated-secret

# Server
SERVER_URL=http://localhost:3000

# Database (auto-set by Railway in production)
DATABASE_URL=postgresql://localhost:5432/zoomdrain
```

### 2.4 Project structure

```
zoom-drain-hub/
├── src/
│   ├── routes/
│   │   ├── health.js        # Status endpoint, leads dashboard, subdomain redirects
│   │   ├── angi.js          # Angi's webhook receiver, lead normalizer, call initiator
│   │   └── twilio.js        # Keypress handler, SMS sender, call status callback
│   ├── services/
│   │   ├── analyzeLead.js   # Claude AI lead scoring and summarization
│   │   ├── leadStore.js     # In-memory store for active call bridging
│   │   └── database.js      # PostgreSQL operations and schema initialization
│   ├── middleware/
│   │   └── rateLimiter.js   # Rate limiting (10 req/min webhook, 5 req/min test)
│   ├── public/
│   │   ├── privacy-policy.html   # Required for 10DLC registration
│   │   ├── terms.html            # Required for 10DLC registration
│   │   └── zoom-drain-logo.png   # Brand logo
│   └── server.js            # Express app, middleware, route registration, DB init
├── .env                     # Local environment variables (never committed)
├── .env.example             # Template — safe to commit
├── .gitignore
├── package.json             # type: "module" (ES modules), start/dev scripts
└── README.md
```

### 2.5 Key implementation notes

**ES Modules** — this project uses `"type": "module"` in `package.json`. All imports use ES module syntax (`import`/`export`), not CommonJS (`require`).

**Trust proxy** — `app.set('trust proxy', 1)` is required in `server.js` for rate limiting to work correctly behind Railway's reverse proxy.

**Lead normalization** — the real Angi's webhook payload has a flat structure (not nested). The `normalizeLead()` function in `angi.js` converts it to the internal format used throughout the app. The real payload fields are:
- `primaryPhone` (not `contact.phone`)
- `taskName` (not `job.type`)
- `comments` (not `job.description`)
- `srOid` / `leadOid` (not `id`)
- `interview[]` — array of Q&A pairs from the customer intake form

**Barge-in keypresses** — the `<Say>` verb is nested *inside* `<Gather>` in the TwiML, which allows you to press 1 or 2 at any point during the summary rather than waiting for it to finish.

**Speech rate** — use the `rate="fast"` attribute on `<Say>` with `voice="Polly.Joanna-Neural"`. Do not use SSML `<prosody>` tags — they cause Twilio to return an empty Say verb error with Polly Neural voices.

### 2.6 Run locally

```bash
npm run dev
```

You should see:
```
Database initialized
Zoom Drain Hub running on port 3000
```

---

## Part 3: Deploy to Railway

### 3.1 Push to GitHub

```bash
git add .
git commit -m "Initial commit"
git push -u origin main
```

### 3.2 Create Railway project

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. Select `zoom-drain-hub` — Railway detects Node.js and deploys automatically

### 3.3 Add PostgreSQL

1. In your Railway project → **+ New** → **Database** → **Add PostgreSQL**
2. Railway injects `DATABASE_URL` into your app service automatically — do not add it manually

### 3.4 Configure environment variables

Go to your app service → **Variables** tab:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `TWILIO_ACCOUNT_SID` | Starts with AC |
| `TWILIO_AUTH_TOKEN` | 32-character hex string — not an API key |
| `TWILIO_PHONE_NUMBER` | E.164 format: `+16025551234` |
| `YOUR_PHONE_NUMBER` | Your cell in E.164 format |
| `MESSAGING_SERVICE_SID` | Starts with MG |
| `ANGI_API_KEY` | Your generated secret |
| `SERVER_URL` | `https://www.yourdomain.com` (no trailing slash) |
| `NODE_ENV` | `production` |

> `DATABASE_URL` is injected automatically — do not add it.

### 3.5 Verify deployment

```bash
curl https://www.yourdomain.com/status
```

All variables should show `✓` with masked values (last 4 characters visible). If any show `✗ missing`, add them in Railway's Variables tab and wait for auto-redeploy.

> **Note on Railway logs:** During deployment you will see `SIGTERM` errors in the logs. This is normal — Railway kills the old container when starting the new one. The logs from both containers are interleaved. Confirm the app is healthy by checking the `/status` endpoint, not the raw logs.

---

## Part 4: Custom Domain Setup

### 4.1 Add domain in Railway

1. Your app service → **Settings → Networking → Custom Domain**
2. Add `www.yourdomain.com`
3. Note the CNAME value Railway shows you

### 4.2 Configure DNS in Namecheap

| Type | Host | Value |
|---|---|---|
| CNAME | www | *(exact value from Railway)* |

### 4.3 SSL certificate

Railway provisions SSL automatically via Let's Encrypt. Watch for the status to change from **Waiting for DNS update** to **Active** (5–15 minutes after DNS propagates). If it gets stuck on "Certificate Authority is validating challenges", click **Try Again** in Railway's networking settings.

### 4.4 Update SERVER_URL

```
SERVER_URL=https://www.yourdomain.com
```

### 4.5 Subdomain redirects

To redirect a subdomain (e.g. for a QR code printed on marketing materials) add a CNAME in Namecheap pointing the subdomain to Railway, add it as a custom domain in Railway, and add a hostname check in `server.js`:

```js
app.use((req, res, next) => {
  if (req.hostname === 'golf.yourdomain.com') {
    return res.redirect(301, 'https://your-destination-url.com');
  }
  next();
});
```

This avoids the SSL certificate errors that Namecheap's URL redirect service causes.

---

## Part 5: Twilio Final Configuration

Once your live `SERVER_URL` is confirmed working, update your Twilio phone number:

**Phone Numbers → Active Numbers → your number → Voice & Fax:**
- "A call comes in" → Webhook → `https://www.yourdomain.com/twilio/gather`
- Method: HTTP POST

---

## Part 6: Connect Angi's Webhook

Contact your Angi's account representative or email `crmintegrations@angi.com` with:
- Your **SPID** (Company ID found in your Angi's Pro account URL)
- Your webhook endpoint: `https://www.yourdomain.com/webhooks/angi`
- Request they include the header: `x-api-key: your-ANGI_API_KEY-value`

The real Angi's webhook payload structure looks like this:

```json
{
  "name": "John Doe",
  "firstName": "John",
  "lastName": "Doe",
  "address": "1234 Elm Street",
  "city": "Anytown",
  "stateProvince": "AZ",
  "postalCode": "85018",
  "primaryPhone": "5559876543",
  "email": "johndoe@example.com",
  "srOid": 123456789,
  "leadOid": 987654321,
  "taskName": "Drain Cleaning - Clear Blockage",
  "comments": "Kitchen sink completely backed up.",
  "matchType": "Lead",
  "leadSource": "AngiesList",
  "interview": [
    { "question": "Is the drain completely blocked?", "answer": "Yes" },
    { "question": "When do you need this done?", "answer": "As soon as possible" }
  ],
  "automatedContactCompliant": true
}
```

---

## Part 7: End-to-End Testing

### 7.1 Fire a test call

```bash
curl -X POST "https://www.yourdomain.com/webhooks/angi/test" \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_ANGI_API_KEY" \
  -d '{
    "name": "Sarah Johnson",
    "firstName": "Sarah",
    "lastName": "Johnson",
    "address": "3842 N 32nd Street",
    "city": "Phoenix",
    "stateProvince": "AZ",
    "postalCode": "85018",
    "primaryPhone": "YOUR_TEST_NUMBER",
    "email": "sarah@example.com",
    "srOid": 112233445,
    "taskName": "Drain Cleaning - Clear Blockage",
    "comments": "Main bathroom drain completely clogged. Water backs up into tub when toilet flushes.",
    "interview": [
      { "question": "Is the drain completely blocked?", "answer": "Yes, completely blocked" },
      { "question": "When do you need this done?", "answer": "As soon as possible - it is urgent" }
    ],
    "automatedContactCompliant": true
  }'
```

Your phone should ring within 5–8 seconds. Press 1 to bridge to the customer, 2 for SMS, or hang up to skip.

> **Note:** Always wrap URLs containing `?` query parameters in quotes in zsh:
> ```bash
> curl "https://www.yourdomain.com/leads?key=YOUR_KEY"
> ```

### 7.2 Test the planning_only flag

Change the interview answer to trigger a lower urgency score:

```json
{ "question": "When do you need this done?", "answer": "Not sure - still planning/budgeting" }
```

Claude should return lower urgency and include `"planning_only"` in the flags array.

### 7.3 Check your lead log

```bash
curl "https://www.yourdomain.com/leads?key=YOUR_ANGI_API_KEY"
```

### 7.4 Verify TwiML

```bash
curl https://www.yourdomain.com/twilio/twiml-test
```

---

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Claude AI API key |
| `TWILIO_ACCOUNT_SID` | ✅ | Starts with AC |
| `TWILIO_AUTH_TOKEN` | ✅ | 32-char hex Auth Token (not an API Key Secret) |
| `TWILIO_PHONE_NUMBER` | ✅ | E.164 format with +1 prefix |
| `YOUR_PHONE_NUMBER` | ✅ | Your personal cell in E.164 format |
| `MESSAGING_SERVICE_SID` | ✅ | Starts with MG |
| `ANGI_API_KEY` | ✅ | Secret for webhook authentication |
| `SERVER_URL` | ✅ | Public URL, no trailing slash |
| `DATABASE_URL` | ✅ | Auto-injected by Railway |
| `NODE_ENV` | ✅ | `production` on Railway |
| `PORT` | ❌ | Defaults to 3000, auto-set by Railway |

---

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/` | None | Health check |
| `GET` | `/status` | None | Config status with masked values |
| `GET` | `/leads` | x-api-key | Recent leads dashboard (last 50) |
| `POST` | `/webhooks/angi` | x-api-key | Live Angi's webhook receiver |
| `POST` | `/webhooks/angi/test` | x-api-key | Test with real Angi payload structure |
| `POST` | `/twilio/gather` | None | Twilio keypress callback |
| `POST` | `/twilio/status` | None | Twilio call status callback |
| `GET` | `/twilio/twiml-test` | None | Preview TwiML voice script |
| `GET` | `/privacy-policy.html` | None | Privacy policy (required for 10DLC) |
| `GET` | `/terms.html` | None | Terms & conditions (required for 10DLC) |

---

## Lead Status Lifecycle

| Status | Meaning |
|---|---|
| `new` | Lead received, call being initiated |
| `called` | Your phone has been dialed |
| `connected` | You pressed 1 and bridged to customer |
| `sms_sent` | You pressed 2 and received text summary |
| `skipped` | You hung up without pressing a key |

---

## Customizing the AI Analysis

The Claude prompt in `src/services/analyzeLead.js` controls scoring and summarization. Key things to tune:

- **`phone_summary`** — word count (currently 15 words max for fast delivery)
- **`estimated_value`** — Claude infers from job description; add price ranges for your market
- **`flags`** — currently: `after_hours`, `commercial`, `repeat_customer`, `competitor_mentioned`, `planning_only`
- **Urgency calibration** — add examples in the prompt to tune for your specific service area
- **Interview data** — the full `interview[]` array is passed to Claude, significantly improving urgency scoring over job description alone

---

## Security

- **API key validation** on all webhook endpoints via `x-api-key` header
- **Rate limiting** — 10 requests/minute on the live webhook, 5/minute on the test endpoint
- **Trust proxy** enabled for accurate IP detection behind Railway's reverse proxy
- **Masked values** in `/status` endpoint — only last 4 characters of each secret are shown
- **SSL enforced** — Railway provisions Let's Encrypt certificates automatically
- **Never commit `.env`** — it is in `.gitignore` by default

**Rotate your ANGI_API_KEY periodically:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Troubleshooting

**Phone never rings after test**
- Check Railway logs for errors after `Processing lead...`
- Verify both phone number variables are in E.164 format: `+16025551234`
- Confirm `TWILIO_AUTH_TOKEN` is the Auth Token from the dashboard — not an API Key Secret
- The Auth Token is a 32-character hex string revealed by clicking the eye icon on the Twilio dashboard

**Press 1 or 2 gives "an application error has occurred"**
- Check Railway logs for `Gather — CallSid:` — if this line doesn't appear, Twilio can't reach your gather URL
- Verify `SERVER_URL` matches your live domain exactly with no trailing slash
- Check Twilio Console → **Monitor → Errors** for the specific TwiML error

**"Suspected Spam" on incoming calls**
- Register at [freecallerregistry.com](https://freecallerregistry.com) with your Twilio number
- Complete your Twilio Trust Hub business profile (Admin → Account Trust Hub)
- These changes take 24–72 hours to propagate to carriers

**10DLC campaign rejected (error 30896)**
- The most common cause is insufficient opt-in description
- Use the exact opt-in and campaign description language provided in Part 1.4 of this README
- Ensure your live terms page explicitly mentions "SMS text messages" and "expressly consent"
- Provide all 5 sample messages when resubmitting

**SSL certificate stuck on "Certificate Authority is validating challenges"**
- Use `www.yourdomain.com` not the root domain
- Verify DNS at [dnschecker.org](https://dnschecker.org) shows green globally before retrying
- Click **Try Again** in Railway's networking settings after confirming DNS is correct

**Claude returns `urgency: unknown`**
- Claude occasionally wraps JSON in markdown fences despite prompt instructions
- The parser in `analyzeLead.js` strips these automatically — check logs for the raw response
- Ensure the model string is `claude-sonnet-4-5` (not a deprecated model string)

**404 on custom domain**
- Confirm the custom domain is added inside the **service settings**, not just at the project level
- Check Railway's networking tab shows the domain as **Active** not **Waiting for DNS update**

**`zsh: no matches found` when running curl**
- Wrap URLs containing `?` in double quotes: `curl "https://domain.com/path?key=value"`

**SIGTERM errors in Railway logs**
- This is normal during deployments — Railway kills the old container when starting the new one
- Confirm app health via `/status` endpoint rather than raw logs

---

## Enhancements Roadmap

**Missed-call SMS to customers**
When you skip a lead or don't answer, automatically send a personalized SMS to the customer. Add to the `/twilio/status` handler when `CallStatus === 'no-answer'`. Requires 10DLC approval.

**Business hours routing**
Non-emergency leads arriving after hours get queued for a morning callback. Check current time in `processLead` before firing the Twilio call and store for next-morning delivery.

**Multi-tech cascade**
If you don't answer within 20 seconds, automatically call a second technician. Use Twilio's `timeout` on `<Dial>` and chain calls via status webhooks.

**Lead analytics dashboard**
Build a simple HTML dashboard at `/dashboard` showing win rate by job type, average response time, and revenue by lead source using data already in PostgreSQL.

**CRM integration**
After a successful connection, POST lead details to your CRM (ServiceTitan, Jobber, Housecall Pro) via their API.

**Appointment confirmation SMS**
After booking, send an automated appointment confirmation using one of the 10DLC-approved sample messages.

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

## Contributing

This project was built to help small service businesses compete on speed-to-lead. If you adapt it for another industry or add features, pull requests are welcome.
