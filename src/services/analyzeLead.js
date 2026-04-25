import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function analyzeLead(lead) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `You are a dispatcher for Zoom Drain, a drain and plumbing company in Phoenix AZ.
Analyze this Angi's lead and respond with valid JSON only — no markdown, no explanation.

Lead data:
${JSON.stringify(lead, null, 2)}

Return exactly this shape:
{
  "urgency": "emergency|high|medium|low",
  "score": <1-10 integer>,
  "phone_summary": "<2 sentences max, natural spoken language, under 30 words total>",
  "job_type": "<short label e.g. drain clog, water heater, leak detection>",
  "estimated_value": "<dollar range e.g. $150-$300>",
  "recommended_action": "call_now|sms_first|schedule_callback",
  "flags": []
}

Flags to include if applicable: "after_hours", "commercial", "repeat_customer", "competitor_mentioned".
For phone_summary: write it as if briefing a plumber verbally. Natural and fast, no full addresses.`
    }]
  });

  try {
    return JSON.parse(message.content[0].text);
  } catch (e) {
    console.error('Claude response was not valid JSON:', message.content[0].text);
    return {
      urgency: 'unknown',
      score: 5,
      phone_summary: 'New Angi lead received. Details unclear — check your app.',
      job_type: 'unknown',
      estimated_value: 'unknown',
      recommended_action: 'call_now',
      flags: []
    };
  }
}
