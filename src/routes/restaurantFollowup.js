/**
 * Restaurant Follow-Up Automation
 * =================================
 * Replaces the n8n follow-up engine with native Node.js/Express endpoints.
 *
 * ENDPOINTS
 *   POST /restaurants/webhook/pipeline    LACRM webhook receiver
 *   POST /restaurants/followup/test       Manual trigger for testing
 *   GET  /restaurants/followup/status     Dashboard: actions, tasks, stats
 *   POST /restaurants/followup/digest     Weekly digest (also runs on cron)
 *   GET  /restaurants/followup/tasks      View pending/overdue tasks
 *   POST /restaurants/followup/tasks/:id/complete   Mark task done
 *
 * HOW IT WORKS
 *   1. You complete a drop-in and move the prospect in LACRM
 *   2. LACRM fires a webhook → POST /webhook/pipeline
 *   3. The handler looks up the new status and runs the matching actions:
 *      - Sends thank-you text via Twilio
 *      - Creates follow-up tasks in LACRM
 *      - Drafts emails via Claude
 *      - Schedules future check-ins
 *   4. Everything is logged in PostgreSQL for the dashboard
 *
 * LACRM WEBHOOK SETUP
 *   URL: https://your-hub.up.railway.app/restaurants/webhook/pipeline
 *   Events: Pipeline Item Status Update
 */

import { Router } from 'express';
import twilio from 'twilio';
import Anthropic from '@anthropic-ai/sdk';
import {
  callLacrm,
  getPipelineItems,
} from '../services/lacrmClient.js';
import {
  logPipelineEvent,
  markEventProcessed,
  logFollowupAction,
  createScheduledTask,
  getRecentActions,
  getFollowupStats,
  getTasksThisWeek,
  getOverdueTasks,
  completeTask,
} from '../services/restaurantDb.js';

const router = Router();

// ── Status name mapping (StatusId → human-readable) ──────────────────────────

const STATUS_MAP = {
  new_prospect:          process.env.LACRM_NEW_PROSPECT_STATUS_ID,
  dropin_scheduled:      process.env.LACRM_DROPIN_SCHEDULED_STATUS_ID,
  dropin_completed:      process.env.LACRM_DROPIN_COMPLETED_STATUS_ID,
  followup_in_progress:  process.env.LACRM_FOLLOWUP_IN_PROGRESS_STATUS_ID,
  walkthrough_scheduled: process.env.LACRM_WALKTHROUGH_SCHEDULED_STATUS_ID,
  walkthrough_completed: process.env.LACRM_WALKTHROUGH_COMPLETED_STATUS_ID,
  proposal_sent:         process.env.LACRM_PROPOSAL_SENT_STATUS_ID,
  negotiation:           process.env.LACRM_NEGOTIATION_STATUS_ID,
  won:                   process.env.LACRM_WON_STATUS_ID,
  lost:                  process.env.LACRM_LOST_STATUS_ID,
  nurture:               process.env.LACRM_NURTURE_STATUS_ID,
};

// Reverse lookup: StatusId → stage name
function statusIdToName(statusId) {
  for (const [name, id] of Object.entries(STATUS_MAP)) {
    if (id === statusId) return name;
  }
  return 'unknown';
}

// ── Twilio + Claude clients ──────────────────────────────────────────────────

function getTwilioClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

function getAnthropicClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// =============================================================================
// POST /webhook/pipeline
// Receives LACRM pipeline status change notifications.
//
// LACRM HANDSHAKE: When you register the webhook via CreateWebhook, LACRM
// sends a POST with an X-Hook-Secret header. We must respond with the same
// header. We also store the secret for payload signature verification.
// =============================================================================

let hookSecret = process.env.LACRM_WEBHOOK_SECRET || '';

router.post('/webhook/pipeline', async (req, res) => {
  // Handle LACRM webhook registration handshake
  const incomingSecret = req.headers['x-hook-secret'];
  if (incomingSecret) {
    console.log('[Restaurant Webhook] Handshake received — registering webhook');
    hookSecret = incomingSecret;
    // LACRM requires the same header in the response
    res.set('X-Hook-Secret', incomingSecret);
    res.sendStatus(200);
    return;
  }

  // Normal webhook event — respond immediately, process async
  res.sendStatus(200);

  try {
    const payload = req.body;
    console.log('[Restaurant Webhook] Event received:', JSON.stringify(payload).slice(0, 500));

    const triggeringEvent = payload.TriggeringEvent || '';
    if (!triggeringEvent.startsWith('PipelineItemStatus')) {
      console.log(`[Restaurant Webhook] Ignoring non-pipeline event: ${triggeringEvent}`);
      return;
    }

    // LACRM sends: { UserId, TriggeringEvent, PipelineItems: [{ PipelineItemId, ... }] }
    const pipelineItems = payload.PipelineItems || [];
    if (!Array.isArray(pipelineItems) || pipelineItems.length === 0) {
      console.warn('[Restaurant Webhook] No PipelineItems in payload');
      return;
    }

    // Process each pipeline item in the event
    for (const item of pipelineItems) {
      const pipelineItemId = item.PipelineItemId || '';
      const contactId      = item.ContactId || '';
      const statusId       = item.StatusId || '';

      // If ContactId isn't in the webhook payload, fetch the full pipeline item
      let resolvedContactId = contactId;
      if (!resolvedContactId && pipelineItemId) {
        const fullItem = await callLacrm('GetPipelineItem', { PipelineItemId: pipelineItemId });
        resolvedContactId = fullItem?.ContactId || '';
      }

      if (!resolvedContactId) {
        console.warn(`[Restaurant Webhook] No ContactId for pipeline item ${pipelineItemId}`);
        continue;
      }

      // Get contact details from LACRM
      const contact = await callLacrm('GetContact', { ContactId: resolvedContactId });
      if (!contact || contact.error) {
        console.error('[Restaurant Webhook] Could not fetch contact:', contact?.error);
        continue;
      }

      const companyName = contact['Company Name'] || contact.CompanyName || 'Unknown';
      const phone       = extractPhone(contact);
      const newStage    = statusIdToName(statusId);

      console.log(`[Restaurant Webhook] ${companyName}: → ${newStage}`);

      // Log the event
      const event = await logPipelineEvent({
        contactId: resolvedContactId,
        companyName,
        oldStatus: 'unknown',
        newStatus: newStage,
        pipelineItemId,
      });

      // Route to the appropriate follow-up handler
      const actions = await handleStageChange(newStage, {
        contactId: resolvedContactId,
        companyName,
        phone,
        contact,
        pipelineItemId,
        oldStage: 'unknown',
      });

      await markEventProcessed(event.id, actions);
      console.log(`[Restaurant Webhook] ${companyName}: ${actions.length} actions taken`);
    }

  } catch (err) {
    console.error('[Restaurant Webhook] Error:', err);
  }
});

// =============================================================================
// POST /webhook/register
// Registers the LACRM webhook via the API. Run this once during setup.
// =============================================================================

router.post('/webhook/register', async (req, res) => {
  const key = req.headers['x-api-key'] || req.query.key;
  if (!key || key !== process.env.ANGI_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const serverUrl = process.env.SERVER_URL;
  if (!serverUrl) {
    return res.status(400).json({ error: 'SERVER_URL not set in environment' });
  }

  const webhookUrl = `${serverUrl}/restaurants/webhook/pipeline`;

  try {
    // First, check for existing webhooks
    const existing = await callLacrm('GetWebhooks', {});
    const hooks = existing?.Results || existing || [];
    
    if (Array.isArray(hooks)) {
      const alreadyRegistered = hooks.find(h => h?.EndpointUrl === webhookUrl || h?.Url === webhookUrl);
      if (alreadyRegistered) {
        return res.json({
          message: 'Webhook already registered',
          webhookId: alreadyRegistered.WebhookId,
          url: webhookUrl,
        });
      }
    }

    // Register the webhook
    const result = await callLacrm('CreateWebhook', {
      EndpointUrl: webhookUrl,
      Events: ['PipelineItemStatus.Create', 'PipelineItemStatus.Update'],
      WebhookScope: 'Account',
    });

    if (result?.error) {
      return res.status(400).json({
        error: 'Failed to register webhook',
        detail: result.error,
        hint: 'Make sure your hub is deployed and accessible at ' + webhookUrl,
      });
    }

    console.log('[Webhook] Registered:', JSON.stringify(result));
    res.json({
      message: 'Webhook registered successfully',
      webhookId: result?.WebhookId,
      url: webhookUrl,
      events: ['PipelineItemStatus.Create', 'PipelineItemStatus.Update'],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// GET /webhook/list
// List all registered LACRM webhooks
// =============================================================================

router.get('/webhook/list', async (req, res) => {
  const key = req.headers['x-api-key'] || req.query.key;
  if (!key || key !== process.env.ANGI_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await callLacrm('GetWebhooks', {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// Stage → Action Router
// =============================================================================

async function handleStageChange(newStage, ctx) {
  const actions = [];

  switch (newStage) {
    case 'dropin_completed':
      actions.push(...await onDropInCompleted(ctx));
      break;

    case 'followup_in_progress':
      actions.push(...await onFollowUpInProgress(ctx));
      break;

    case 'walkthrough_scheduled':
      actions.push(...await onWalkthroughScheduled(ctx));
      break;

    case 'walkthrough_completed':
      actions.push(...await onWalkthroughCompleted(ctx));
      break;

    case 'proposal_sent':
      actions.push(...await onProposalSent(ctx));
      break;

    case 'won':
      actions.push(...await onWon(ctx));
      break;

    case 'lost':
      actions.push(...await onLost(ctx));
      break;

    case 'nurture':
      actions.push(...await onNurture(ctx));
      break;

    default:
      console.log(`[Followup] No automated actions for stage: ${newStage}`);
  }

  return actions;
}

// =============================================================================
// Stage Handlers
// =============================================================================

// ── Drop-In Completed ────────────────────────────────────────────────────────
// → Thank-you text via Twilio
// → Create "Follow-up call" task in LACRM due in 5 days
// → Schedule check-in in our DB

async function onDropInCompleted(ctx) {
  const actions = [];

  // 1. Send thank-you text
  const textResult = await sendThankYouText(ctx);
  if (textResult) actions.push(textResult);

  // 2. Create follow-up call task in LACRM
  const dueDate = addDays(new Date(), 5);
  const taskResult = await createLacrmTask(ctx, {
    name: `Follow-up call — ${ctx.companyName}`,
    dueDate: formatDate(dueDate),
    description: `Call ${ctx.companyName} to follow up on your drop-in visit. Review talking points in the enrichment note.`,
  });
  if (taskResult) actions.push(taskResult);

  // 3. Schedule in our DB for tracking
  await createScheduledTask({
    contactId: ctx.contactId,
    companyName: ctx.companyName,
    taskType: 'followup_call',
    description: `Follow-up call after drop-in visit`,
    dueDate: formatDate(dueDate),
  });

  return actions;
}

// ── Follow-Up In Progress ────────────────────────────────────────────────────
// → Draft value-add email via Claude
// → Create "Check-in call" task due in 30 days

async function onFollowUpInProgress(ctx) {
  const actions = [];

  // 1. Draft a value-add email using Claude
  const emailResult = await draftValueAddEmail(ctx);
  if (emailResult) actions.push(emailResult);

  // 2. Create 30-day check-in task
  const dueDate = addDays(new Date(), 30);
  const taskResult = await createLacrmTask(ctx, {
    name: `30-day check-in — ${ctx.companyName}`,
    dueDate: formatDate(dueDate),
    description: `Monthly check-in with ${ctx.companyName}. Review previous interactions and any seasonal drain tips.`,
  });
  if (taskResult) actions.push(taskResult);

  await createScheduledTask({
    contactId: ctx.contactId,
    companyName: ctx.companyName,
    taskType: 'checkin_call',
    description: `30-day check-in after initial follow-up`,
    dueDate: formatDate(dueDate),
  });

  return actions;
}

// ── Walk-Through Scheduled ───────────────────────────────────────────────────
// → Send prep reminder to Dave (text)
// → Create prep checklist task for day before

async function onWalkthroughScheduled(ctx) {
  const actions = [];

  // Send Dave a reminder
  try {
    const client = getTwilioClient();
    await client.messages.create({
      body: `📋 Walk-through scheduled: ${ctx.companyName}. Remember camera, flashlight, and proposal template.`,
      to: process.env.YOUR_PHONE_NUMBER,
      from: process.env.TWILIO_PHONE_NUMBER,
    });
    const action = await logFollowupAction({
      contactId: ctx.contactId,
      companyName: ctx.companyName,
      actionType: 'sms_prep_reminder',
      actionDetail: 'Walk-through prep reminder sent to Dave',
      triggeredBy: 'webhook',
    });
    actions.push({ type: 'sms_prep_reminder', success: true });
  } catch (err) {
    console.error('[Followup] Prep reminder SMS error:', err.message);
  }

  return actions;
}

// ── Walk-Through Completed ───────────────────────────────────────────────────
// → Create "Send proposal" task due in 24 hours

async function onWalkthroughCompleted(ctx) {
  const actions = [];
  const dueDate = addDays(new Date(), 1);

  const taskResult = await createLacrmTask(ctx, {
    name: `Send proposal — ${ctx.companyName}`,
    dueDate: formatDate(dueDate),
    description: `Send service agreement proposal to ${ctx.companyName} within 24 hours of walk-through.`,
  });
  if (taskResult) actions.push(taskResult);

  await createScheduledTask({
    contactId: ctx.contactId,
    companyName: ctx.companyName,
    taskType: 'send_proposal',
    description: `Send proposal within 24 hours`,
    dueDate: formatDate(dueDate),
  });

  return actions;
}

// ── Proposal Sent ────────────────────────────────────────────────────────────
// → Create "Follow up on proposal" task due in 7 days

async function onProposalSent(ctx) {
  const actions = [];
  const dueDate = addDays(new Date(), 7);

  const taskResult = await createLacrmTask(ctx, {
    name: `Follow up on proposal — ${ctx.companyName}`,
    dueDate: formatDate(dueDate),
    description: `Check if ${ctx.companyName} has reviewed the proposal. Address any questions or concerns.`,
  });
  if (taskResult) actions.push(taskResult);

  await createScheduledTask({
    contactId: ctx.contactId,
    companyName: ctx.companyName,
    taskType: 'proposal_followup',
    description: `Follow up on proposal sent 7 days ago`,
    dueDate: formatDate(dueDate),
  });

  return actions;
}

// ── Won ──────────────────────────────────────────────────────────────────────
// → Send Dave a congratulations text
// → Create onboarding tasks

async function onWon(ctx) {
  const actions = [];

  try {
    const client = getTwilioClient();
    await client.messages.create({
      body: `🎉 NEW ACCOUNT WON: ${ctx.companyName}! Time to schedule the first service visit.`,
      to: process.env.YOUR_PHONE_NUMBER,
      from: process.env.TWILIO_PHONE_NUMBER,
    });
    await logFollowupAction({
      contactId: ctx.contactId,
      companyName: ctx.companyName,
      actionType: 'sms_won_notification',
      actionDetail: 'Won notification sent to Dave',
      triggeredBy: 'webhook',
    });
    actions.push({ type: 'sms_won_notification', success: true });
  } catch (err) {
    console.error('[Followup] Won notification error:', err.message);
  }

  // Create onboarding tasks
  const dueDate = addDays(new Date(), 3);
  await createLacrmTask(ctx, {
    name: `Schedule first service — ${ctx.companyName}`,
    dueDate: formatDate(dueDate),
    description: `Schedule the first service visit for ${ctx.companyName}. Confirm scope, access, and timing.`,
  });

  await createScheduledTask({
    contactId: ctx.contactId,
    companyName: ctx.companyName,
    taskType: 'schedule_first_service',
    description: `Schedule first service within 3 days`,
    dueDate: formatDate(dueDate),
  });

  actions.push({ type: 'lacrm_task', success: true, task: 'schedule_first_service' });
  return actions;
}

// ── Lost ─────────────────────────────────────────────────────────────────────
// → Create quarterly nurture task (90 days)

async function onLost(ctx) {
  const actions = [];
  const dueDate = addDays(new Date(), 90);

  await createScheduledTask({
    contactId: ctx.contactId,
    companyName: ctx.companyName,
    taskType: 'nurture_quarterly',
    description: `Quarterly check-in — was lost 90 days ago. See if situation has changed.`,
    dueDate: formatDate(dueDate),
  });

  await logFollowupAction({
    contactId: ctx.contactId,
    companyName: ctx.companyName,
    actionType: 'nurture_scheduled',
    actionDetail: `Quarterly nurture scheduled for ${formatDate(dueDate)}`,
    triggeredBy: 'webhook',
  });

  actions.push({ type: 'nurture_scheduled', dueDate: formatDate(dueDate) });
  return actions;
}

// ── Nurture ──────────────────────────────────────────────────────────────────
// → Schedule seasonal touchpoint (90 days)

async function onNurture(ctx) {
  const actions = [];
  const dueDate = addDays(new Date(), 90);

  await createScheduledTask({
    contactId: ctx.contactId,
    companyName: ctx.companyName,
    taskType: 'nurture_seasonal',
    description: `Seasonal touchpoint — send a helpful drain tip or check in.`,
    dueDate: formatDate(dueDate),
  });

  actions.push({ type: 'nurture_seasonal', dueDate: formatDate(dueDate) });
  return actions;
}

// =============================================================================
// Action Helpers
// =============================================================================

async function sendThankYouText(ctx) {
  const phone = ctx.phone;
  if (!phone) {
    console.log(`[Followup] No phone for ${ctx.companyName} — skipping thank-you text`);
    return null;
  }

  // Get enrichment data for personalization
  let talkingPoint = '';
  const contact = ctx.contact;
  if (contact) {
    const cuisineType = contact['Cuisine Type'] || '';
    if (cuisineType && cuisineType !== 'Other') {
      talkingPoint = ` I know ${cuisineType.toLowerCase()} kitchens have unique drain challenges —`;
    }
  }

  const message = `Hi! This is Dave from Zoom Drain. Great meeting you today at ${ctx.companyName}.${talkingPoint} I'd love to chat more about keeping your drains in top shape. My direct line: ${process.env.TWILIO_PHONE_NUMBER}. Have a great day!`;

  try {
    const client = getTwilioClient();
    await client.messages.create({
      body: message,
      to: phone,
      from: process.env.TWILIO_PHONE_NUMBER,
    });

    const action = await logFollowupAction({
      contactId: ctx.contactId,
      companyName: ctx.companyName,
      actionType: 'sms_thankyou',
      actionDetail: `Thank-you text sent to ${phone}`,
      triggeredBy: 'webhook',
      metadata: { phone, messagePreview: message.slice(0, 100) },
    });

    console.log(`[Followup] Thank-you text sent to ${ctx.companyName} at ${phone}`);
    return { type: 'sms_thankyou', success: true, phone };
  } catch (err) {
    console.error(`[Followup] Thank-you text failed for ${ctx.companyName}:`, err.message);
    await logFollowupAction({
      contactId: ctx.contactId,
      companyName: ctx.companyName,
      actionType: 'sms_thankyou',
      actionDetail: `Failed: ${err.message}`,
      status: 'failed',
      triggeredBy: 'webhook',
    });
    return { type: 'sms_thankyou', success: false, error: err.message };
  }
}

async function draftValueAddEmail(ctx) {
  try {
    const claude = getAnthropicClient();

    // Get enrichment data
    const cuisineType = ctx.contact?.['Cuisine Type'] || 'restaurant';
    const season = getSeason();

    const response = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `Write a short, helpful email from Dave at Zoom Drain to the team at ${ctx.companyName}.
The restaurant is a ${cuisineType} establishment.
Include one specific, useful drain maintenance tip relevant to their cuisine type and the current season (${season}).
Keep it under 200 words. Friendly, helpful, not salesy.
Subject line should be practical and interesting.

Return as JSON: { "subject": "...", "body": "..." }
Return raw JSON only. No markdown.`,
      }],
    });

    const text = response.content[0].text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    const email = JSON.parse(text);

    // Log the draft — Dave reviews before sending
    const action = await logFollowupAction({
      contactId: ctx.contactId,
      companyName: ctx.companyName,
      actionType: 'email_draft',
      actionDetail: `Subject: ${email.subject}`,
      triggeredBy: 'webhook',
      metadata: { subject: email.subject, body: email.body },
    });

    // Also add as a LACRM note so Dave can see it
    await callLacrm('CreateNote', {
      ContactId: ctx.contactId,
      Note: `📧 DRAFT EMAIL (review before sending)\n\nSubject: ${email.subject}\n\n${email.body}`,
    });

    console.log(`[Followup] Email drafted for ${ctx.companyName}: "${email.subject}"`);
    return { type: 'email_draft', success: true, subject: email.subject };
  } catch (err) {
    console.error(`[Followup] Email draft failed for ${ctx.companyName}:`, err.message);
    return { type: 'email_draft', success: false, error: err.message };
  }
}

async function createLacrmTask(ctx, { name, dueDate, description }) {
  try {
    const result = await callLacrm('CreateTask', {
      Name: name,
      DueDate: dueDate,
      Description: description,
      ContactId: ctx.contactId,
    });

    if (result?.error) {
      console.error(`[Followup] LACRM task creation failed:`, result.error);
      return { type: 'lacrm_task', success: false, error: result.error };
    }

    await logFollowupAction({
      contactId: ctx.contactId,
      companyName: ctx.companyName,
      actionType: 'lacrm_task',
      actionDetail: name,
      triggeredBy: 'webhook',
      metadata: { dueDate, taskId: result?.TaskId },
    });

    console.log(`[Followup] LACRM task created: "${name}" due ${dueDate}`);
    return { type: 'lacrm_task', success: true, name, dueDate };
  } catch (err) {
    console.error(`[Followup] LACRM task error:`, err.message);
    return { type: 'lacrm_task', success: false, error: err.message };
  }
}

// =============================================================================
// POST /followup/test
// Manually trigger follow-up actions for testing
// =============================================================================

router.post('/followup/test', async (req, res) => {
  const key = req.headers['x-api-key'] || req.query.key;
  if (!key || key !== process.env.ANGI_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { contactId, stage } = req.body;
  if (!contactId || !stage) {
    return res.status(400).json({ error: 'contactId and stage are required' });
  }

  try {
    const contact = await callLacrm('GetContact', { ContactId: contactId });
    if (!contact || contact.error) {
      return res.status(404).json({ error: 'Contact not found in LACRM' });
    }

    const companyName = contact['Company Name'] || contact.CompanyName || 'Unknown';
    const phone = extractPhone(contact);

    const actions = await handleStageChange(stage, {
      contactId,
      companyName,
      phone,
      contact,
      pipelineItemId: '',
      oldStage: 'unknown',
    });

    res.json({ companyName, stage, actions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// GET /followup/status
// Dashboard: stats, recent actions, pending tasks
// =============================================================================

router.get('/followup/status', async (req, res) => {
  const key = req.headers['x-api-key'] || req.query.key;
  if (!key || key !== process.env.ANGI_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const [stats, recentActions, tasksThisWeek, overdueTasks] = await Promise.all([
      getFollowupStats(),
      getRecentActions(20),
      getTasksThisWeek(),
      getOverdueTasks(),
    ]);

    res.json({ stats, recentActions, tasksThisWeek, overdueTasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// GET /followup/tasks
// View pending and overdue tasks
// =============================================================================

router.get('/followup/tasks', async (req, res) => {
  const key = req.headers['x-api-key'] || req.query.key;
  if (!key || key !== process.env.ANGI_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const [thisWeek, overdue] = await Promise.all([
      getTasksThisWeek(),
      getOverdueTasks(),
    ]);
    res.json({ thisWeek, overdue });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// POST /followup/tasks/:id/complete
// Mark a scheduled task as done
// =============================================================================

router.post('/followup/tasks/:id/complete', async (req, res) => {
  const key = req.headers['x-api-key'] || req.query.key;
  if (!key || key !== process.env.ANGI_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    await completeTask(req.params.id);
    res.json({ success: true, message: `Task ${req.params.id} marked complete` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// POST /followup/digest
// Weekly digest — also called by cron
// =============================================================================

router.post('/followup/digest', async (req, res) => {
  const key = req.headers['x-api-key'] || req.query.key;
  if (!key || key !== process.env.ANGI_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const digest = await buildAndSendDigest();
    res.json(digest);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function buildAndSendDigest() {
  // Get pipeline stats from LACRM
  const pipelineId = process.env.LACRM_PIPELINE_ID;
  const items = pipelineId ? await getPipelineItems(pipelineId) : [];

  // Count by status
  const statusCounts = {};
  for (const item of items) {
    const name = statusIdToName(item.StatusId || '');
    statusCounts[name] = (statusCounts[name] || 0) + 1;
  }

  // Get task data
  const [tasksThisWeek, overdue] = await Promise.all([
    getTasksThisWeek(),
    getOverdueTasks(),
  ]);

  // Build digest message
  const lines = [
    `📋 Weekly Pipeline Summary`,
    `Pipeline: ${items.length} total`,
  ];

  const stageOrder = ['new_prospect', 'dropin_scheduled', 'dropin_completed',
    'followup_in_progress', 'walkthrough_scheduled', 'proposal_sent', 'won'];
  for (const stage of stageOrder) {
    if (statusCounts[stage]) {
      lines.push(`  ${formatStageName(stage)}: ${statusCounts[stage]}`);
    }
  }

  lines.push(`This week: ${tasksThisWeek.length} tasks due`);
  if (overdue.length > 0) {
    lines.push(`⚠️ ${overdue.length} overdue tasks`);
  }

  const message = lines.join('\n');

  // Send via Twilio
  try {
    const client = getTwilioClient();
    await client.messages.create({
      body: message,
      to: process.env.YOUR_PHONE_NUMBER,
      from: process.env.TWILIO_PHONE_NUMBER,
    });
    console.log('[Digest] Weekly digest sent');
  } catch (err) {
    console.error('[Digest] Failed to send:', err.message);
  }

  return { message, tasksThisWeek: tasksThisWeek.length, overdue: overdue.length, pipeline: statusCounts };
}

// =============================================================================
// Cron: Weekly Digest (Monday 7:30 AM Arizona time)
// =============================================================================

export function startDigestCron() {
  const MONDAY = 1;
  const TARGET_HOUR = 7;
  const TARGET_MINUTE = 30;

  // Check every 15 minutes if it's time to send
  setInterval(async () => {
    const now = new Date();
    // Arizona is UTC-7 year-round (no DST)
    const azHour = (now.getUTCHours() - 7 + 24) % 24;
    const azMinute = now.getUTCMinutes();
    const azDay = now.getUTCDay();

    // Adjust day if UTC-7 crosses midnight
    const adjustedDay = azHour > now.getUTCHours() ? (azDay - 1 + 7) % 7 : azDay;

    if (adjustedDay === MONDAY && azHour === TARGET_HOUR && azMinute >= TARGET_MINUTE && azMinute < TARGET_MINUTE + 15) {
      console.log('[Digest Cron] Sending weekly digest...');
      try {
        await buildAndSendDigest();
      } catch (err) {
        console.error('[Digest Cron] Error:', err);
      }
    }
  }, 15 * 60 * 1000); // Check every 15 minutes

  console.log('[Digest Cron] Scheduled for Mondays at 7:30 AM Arizona time');
}

// =============================================================================
// Helpers
// =============================================================================

function extractPhone(contact) {
  const phones = contact?.Phone || [];
  if (Array.isArray(phones) && phones.length > 0) {
    return phones[0]?.Text || phones[0] || '';
  }
  return typeof phones === 'string' ? phones : '';
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function getSeason() {
  const month = new Date().getMonth();
  if (month >= 2 && month <= 4) return 'spring';
  if (month >= 5 && month <= 7) return 'summer';
  if (month >= 8 && month <= 10) return 'fall';
  return 'winter';
}

function formatStageName(name) {
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export default router;
