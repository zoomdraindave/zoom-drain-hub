import { Router } from 'express';

const router = Router();

// Twilio calls this when you press a key during the lead call
router.post('/gather', async (req, res) => {
  const { Digits, CallSid } = req.body;
  console.log(`Gather response — CallSid: ${CallSid}, Digits: ${Digits}`);

  if (Digits === '1') {
    // TODO: pull lead from DB by CallSid and bridge the call
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">Connecting you to the customer now.</Say>
  <Dial callerId="${process.env.TWILIO_PHONE_NUMBER}">
    <Number>+16025559999</Number>
  </Dial>
</Response>`;
    res.type('text/xml').send(twiml);
  } else {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">Lead has been logged. Goodbye.</Say>
</Response>`;
    res.type('text/xml').send(twiml);
  }
});

// Twilio calls this when a call ends — for logging and follow-up
router.post('/status', async (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body;
  console.log(`Call status update — ${CallSid}: ${CallStatus} (${CallDuration}s)`);
  // TODO: update lead record in DB
  res.sendStatus(200);
});

// Test endpoint — returns sample TwiML so you can verify the XML without a real call
router.get('/twiml-test', (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">
    New Angi lead. High urgency. Kitchen sink completely backed up at 4521 East Camelback Road.
    Customer is John Smith. Estimated job value: 150 to 300 dollars.
    Press 1 to connect. Press 2 for a text summary. Hang up to skip.
  </Say>
  <Gather numDigits="1" action="/twilio/gather" method="POST" timeout="15">
    <Say voice="Polly.Joanna-Neural">Press 1 to connect now.</Say>
  </Gather>
</Response>`;
  res.type('text/xml').send(twiml);
});

export default router;
