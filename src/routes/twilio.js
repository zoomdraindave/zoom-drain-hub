import { Router } from 'express';
import twilio from 'twilio';
import { getLead } from '../services/leadStore.js';

const router = Router();
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

router.post('/gather', async (req, res) => {
  const { Digits, CallSid } = req.body;
  console.log(`Gather — CallSid: ${CallSid}, Digits pressed: ${Digits}`);

  const record = getLead(CallSid);

  if (!record) {
    console.warn(`No lead found for CallSid ${CallSid}`);
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say voice="Polly.Joanna-Neural">Lead data not found. Please check your app.</Say></Response>`);
    return;
  }

  if (Digits === '1') {
    console.log(`Connecting to customer: ${record.customerPhone}`);
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">Connecting you now. Good luck.</Say>
  <Dial callerId="${process.env.TWILIO_PHONE_NUMBER}" timeout="30">
    <Number>${record.customerPhone}</Number>
  </Dial>
</Response>`);

  } else if (Digits === '2') {
    const { lead, analysis } = record;
    const smsBody =
      `Angi Lead: ${lead.contact.name} — ${lead.contact.phone}\n` +
      `${analysis.job_type} | ${analysis.estimated_value}\n` +
      `${lead.job.description?.slice(0, 100)}`;

    try {
      await twilioClient.messages.create({
        body: smsBody,
        to: process.env.YOUR_PHONE_NUMBER,
        from: process.env.TWILIO_PHONE_NUMBER,
        messagingServiceSid: process.env.MESSAGING_SERVICE_SID,
      });
      console.log('SMS summary sent');
    } catch (err) {
      console.error('SMS send error:', err.message);
    }

    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say voice="Polly.Joanna-Neural">Text sent to your phone. Goodbye.</Say></Response>`);

  } else {
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say voice="Polly.Joanna-Neural">Lead logged. Goodbye.</Say></Response>`);
  }
});

router.post('/status', async (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body;
  console.log(`Call status — ${CallSid}: ${CallStatus} (${CallDuration || 0}s)`);
  res.sendStatus(200);
});

router.get('/twiml-test', (req, res) => {
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">
    New Angi lead. High priority. Kitchen sink backed up near Camelback and 44th.
    Customer is John Smith. Estimated value 150 to 300 dollars.
    Press 1 to connect. Press 2 for a text. Hang up to skip.
  </Say>
</Response>`);
});

export default router;