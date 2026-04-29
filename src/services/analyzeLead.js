import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function analyzeLead(lead) {
  // Build interview summary if present
  const interviewText = lead.interview?.length
    ? lead.interview.map(q => `  Q: ${q.question}\n  A: ${q.answer}`).join('\n')
    : 'No interview data';

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `You are a dispatcher for Zoom Drain, a drain and plumbing company in Phoenix AZ.
Analyze this Angi's lead and respond with valid JSON only — no markdown, no explanation.

Lead details:
- Customer: ${lead.contact.name}
- Job type: ${lead.job.type}
- Location: ${lead.job.city}, ${lead.job.state}
- Comments: ${lead.job.description}
- Lead source: ${lead.leadSource}
- Match type: ${lead.matchType}

Customer interview answers:
${interviewText}

Return exactly this shape:
{
  "urgency": "emergency|high|medium|low",
  "score": <1-10 integer>,
  "phone_summary": "<1 sentence max, under 15 words, punchy and direct>",
  "job_type": "<short label e.g. drain clog, water heater, leak detection>",
  "estimated_value": "<dollar range e.g. $150-$300>",
  "recommended_action": "call_now|sms_first|schedule_callback",
  "flags": []
}

Flags to include if applicable: "after_hours", "commercial", "repeat_customer", "competitor_mentioned", "planning_only".
Use "planning_only" if the customer indicates they are still budgeting or not ready to proceed soon.
For phone_summary: write it as if briefing a plumber verbally. Natural and fast, neighborhood only not full address.
Important: Return raw JSON only. The first character of your response must be {.`
    }]
  });

  try {
    const text = message.content[0].text;
    const cleaned = text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('Claude response was not valid JSON:', message.content[0].text);
    return {
      urgency: 'unknown',
      score: 5,
      phone_summary: 'New Angi lead received. Details unclear — check your app.',
      job_type: lead.job.type || 'unknown',
      estimated_value: 'unknown',
      recommended_action: 'call_now',
      flags: [],
    };
  }
}