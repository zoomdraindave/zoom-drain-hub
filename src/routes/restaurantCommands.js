/**
 * Restaurant Command Handler (WhatsApp + SMS)
 * ==============================================
 * Receives inbound messages from Dave via WhatsApp (preferred) or SMS
 * and executes restaurant automation commands.
 *
 * COMMANDS
 *   DONE [name]              Move restaurant to Drop-In Completed
 *   NOTE [name] | [text]     Add a note to restaurant's LACRM record
 *   APPROVE [id]             Approve a queued outbound message
 *   APPROVE ALL              Approve all pending messages
 *   REJECT [id]              Reject a queued message
 *   QUEUE                    List pending approvals
 *   STATUS                   Pipeline summary
 *   NEXT                     Next scheduled stop details
 *   SKIP [name]              Mark current stop as skipped
 *   HELP                     List available commands
 *
 * WHATSAPP SETUP
 *   1. Twilio Console → Messaging → WhatsApp Sandbox (for testing)
 *      OR register a WhatsApp sender via Self Sign-up (for production)
 *   2. Set the inbound webhook to:
 *      https://your-hub.up.railway.app/restaurants/commands/inbound
 *   3. Text the join code from your WhatsApp to connect to the sandbox
 *
 * SMS FALLBACK
 *   The same endpoint handles SMS if WhatsApp isn't configured.
 *   Set your Twilio phone number's messaging webhook to the same URL.
 */

import { Router } from 'express';
import twilio from 'twilio';
import {
  callLacrm,
  findCompanyByName,
  getPipelineItems,
} from '../services/lacrmClient.js';
import {
  getPendingApprovals,
  getApprovalById,
  approveQueueItem,
  rejectQueueItem,
  logFollowupAction,
  getOverdueTasks,
  getTasksThisWeek,
} from '../services/restaurantDb.js';
import {
  sendExternalSms,
  isWhatsAppMessage,
  getCleanNumber,
} from '../services/messaging.js';

const router = Router();

// Only accept messages from Dave's phone number
function isAuthorized(from) {
  const davePhone = process.env.YOUR_PHONE_NUMBER;
  if (!davePhone) return false;
  const normalize = (p) => p.replace(/[\s\-\+]/g, '').replace(/^1/, '').replace('whatsapp:', '');
  return normalize(from) === normalize(davePhone);
}

// =============================================================================
// POST /commands/inbound — Twilio webhook for incoming WhatsApp/SMS
// =============================================================================

router.post('/commands/inbound', async (req, res) => {
  const { From, Body } = req.body;
  const isWhatsApp = isWhatsAppMessage(req);
  const channel = isWhatsApp ? 'WhatsApp' : 'SMS';
  const twiml = new twilio.twiml.MessagingResponse();

  if (!isAuthorized(From)) {
    console.warn(`[Commands] Unauthorized ${channel} from ${From}`);
    twiml.message('This number is not authorized.');
    res.type('text/xml').send(twiml.toString());
    return;
  }

  const text = (Body || '').trim();
  console.log(`[Commands] ${channel} from Dave: "${text}"`);

  try {
    const reply = await handleCommand(text);
    twiml.message(reply);
  } catch (err) {
    console.error(`[Commands] Error:`, err);
    twiml.message(`❌ Error: ${err.message}`);
  }

  res.type('text/xml').send(twiml.toString());
});

// =============================================================================
// Command Router
// =============================================================================

async function handleCommand(text) {
  const upper = text.toUpperCase();
  const parts = text.split(/\s+/);
  const command = parts[0].toUpperCase();

  switch (command) {
    case 'DONE':    return await cmdDone(text.slice(5).trim());
    case 'NOTE':    return await cmdNote(text.slice(5).trim());
    case 'APPROVE': return upper === 'APPROVE ALL' ? await cmdApproveAll() : await cmdApprove(parts[1]);
    case 'REJECT':  return await cmdReject(parts[1]);
    case 'QUEUE':   return await cmdQueue();
    case 'STATUS':  return await cmdStatus();
    case 'NEXT':    return await cmdNext();
    case 'SKIP':    return await cmdSkip(text.slice(5).trim());
    case 'HELP':    return cmdHelp();
    default:        return `Unknown command: "${command}"\n\nText *HELP* for available commands.`;
  }
}

// =============================================================================
// Command Implementations
// =============================================================================

async function cmdDone(name) {
  if (!name) return '❌ Usage: DONE [restaurant name]';

  const contactId = await findCompanyByName(name);
  if (!contactId) return `❌ Restaurant not found: "${name}"`;

  const contact = await callLacrm('GetContact', { ContactId: contactId });
  const companyName = contact?.['Company Name'] || name;

  const pipelineId = process.env.LACRM_PIPELINE_ID;
  const completedStatusId = process.env.LACRM_DROPIN_COMPLETED_STATUS_ID;

  if (!completedStatusId) {
    return '❌ LACRM_DROPIN_COMPLETED_STATUS_ID not configured';
  }

  const items = await callLacrm('GetPipelineItemsAttachedToContact', { ContactId: contactId });
  const pipelineItems = Array.isArray(items) ? items : (items?.PipelineItems || []);
  const item = pipelineItems.find(i => i?.PipelineId === pipelineId);

  if (item) {
    await callLacrm('EditPipelineItem', {
      PipelineItemId: item.PipelineItemId,
      StatusId: completedStatusId,
    });
  }

  await logFollowupAction({
    contactId,
    companyName,
    actionType: 'dropin_completed_command',
    actionDetail: 'Marked as completed via WhatsApp',
    triggeredBy: 'whatsapp',
  });

  return `✅ *${companyName}* → Drop-In Completed\n\nFollow-up actions will be queued for your approval.`;
}

async function cmdNote(text) {
  let name, noteText;
  if (text.includes('|')) {
    const parts = text.split('|');
    name = parts[0].trim();
    noteText = parts.slice(1).join('|').trim();
  } else {
    const words = text.split(/\s+/);
    if (words.length < 3) return '❌ Usage: NOTE [restaurant name] | [note text]';

    for (let i = Math.min(5, words.length - 1); i >= 1; i--) {
      const tryName = words.slice(0, i).join(' ');
      const contactId = await findCompanyByName(tryName);
      if (contactId) {
        name = tryName;
        noteText = words.slice(i).join(' ');
        break;
      }
    }

    if (!name) return `❌ Could not find restaurant in: "${text}"\nTry: NOTE restaurant name | your note text`;
  }

  const contactId = await findCompanyByName(name);
  if (!contactId) return `❌ Restaurant not found: "${name}"`;

  const contact = await callLacrm('GetContact', { ContactId: contactId });
  const companyName = contact?.['Company Name'] || name;

  const result = await callLacrm('CreateNote', {
    ContactId: contactId,
    Note: `📱 [Via WhatsApp] ${noteText}`,
  });

  if (result?.error) return `❌ Failed to create note: ${result.error}`;

  return `📝 Note added to *${companyName}*:\n"${noteText}"`;
}

async function cmdApprove(idStr) {
  if (!idStr) return '❌ Usage: APPROVE [id] or APPROVE ALL';

  const id = parseInt(idStr, 10);
  if (isNaN(id)) return `❌ Invalid ID: "${idStr}"`;

  const item = await getApprovalById(id);
  if (!item) return `❌ Queue item #${id} not found`;
  if (item.status !== 'pending') return `⚠️ Item #${id} already ${item.status}`;

  await approveQueueItem(id);
  const result = await executeApprovedAction(item);

  return `✅ *Approved #${id}*: ${item.action_type} to ${item.company_name}\n${result}`;
}

async function cmdApproveAll() {
  const pending = await getPendingApprovals(50);
  if (pending.length === 0) return '📋 No pending approvals.';

  const results = [];
  for (const item of pending) {
    await approveQueueItem(item.id);
    const result = await executeApprovedAction(item);
    results.push(`#${item.id} ${item.company_name}: ${result}`);
  }

  return `✅ *Approved ${pending.length} items:*\n${results.join('\n')}`;
}

async function cmdReject(idStr) {
  if (!idStr) return '❌ Usage: REJECT [id]';

  const id = parseInt(idStr, 10);
  if (isNaN(id)) return `❌ Invalid ID: "${idStr}"`;

  const item = await rejectQueueItem(id);
  if (!item) return `❌ Queue item #${id} not found or already processed`;

  return `🚫 *Rejected #${item.id}*: ${item.action_type} to ${item.company_name}`;
}

async function cmdQueue() {
  const pending = await getPendingApprovals(10);
  if (pending.length === 0) return '📋 No pending approvals. You\'re all caught up!';

  const lines = pending.map(item => {
    const preview = item.body.length > 80 ? item.body.slice(0, 80) + '...' : item.body;
    return `*#${item.id}* [${item.action_type}] ${item.company_name}\n   _${preview}_`;
  });

  return `📋 *${pending.length} pending:*\n\n${lines.join('\n\n')}\n\nReply APPROVE [id] or REJECT [id]`;
}

async function cmdStatus() {
  const pipelineId = process.env.LACRM_PIPELINE_ID;
  if (!pipelineId) return '❌ Pipeline not configured';

  const items = await getPipelineItems(pipelineId);
  const pending = await getPendingApprovals(100);
  const [overdue, thisWeek] = await Promise.all([getOverdueTasks(), getTasksThisWeek()]);

  return [
    `📊 *Pipeline Summary*`,
    `Total prospects: ${items.length}`,
    `📋 ${pending.length} messages awaiting approval`,
    `📅 ${thisWeek.length} tasks this week`,
    overdue.length > 0 ? `⚠️ ${overdue.length} overdue tasks` : '✅ No overdue tasks',
  ].join('\n');
}

async function cmdNext() {
  const today = new Date().toISOString().split('T')[0];
  const events = await callLacrm('GetEvents', { StartDate: today, EndDate: today });
  const eventList = events?.Results || (Array.isArray(events) ? events : []);

  const dropIns = eventList.filter(e =>
    e?.Name?.includes('Drop-In') || e?.Name?.includes('🚐')
  );

  if (dropIns.length === 0) return '📍 No drop-in visits scheduled for today.';

  const lines = dropIns.slice(0, 5).map((e, i) => {
    const name = (e.Name || '').replace('🚐 Drop-In: ', '');
    const time = e.StartTime || 'TBD';
    return `${i + 1}. [${time}] *${name}*`;
  });

  return `📍 *Today's stops:*\n${lines.join('\n')}`;
}

async function cmdSkip(name) {
  if (!name) return '❌ Usage: SKIP [restaurant name]';

  const contactId = await findCompanyByName(name);
  if (!contactId) return `❌ Restaurant not found: "${name}"`;

  const contact = await callLacrm('GetContact', { ContactId: contactId });
  const companyName = contact?.['Company Name'] || name;

  const pipelineId = process.env.LACRM_PIPELINE_ID;
  const newProspectStatusId = process.env.LACRM_NEW_PROSPECT_STATUS_ID;

  const items = await callLacrm('GetPipelineItemsAttachedToContact', { ContactId: contactId });
  const pipelineItems = Array.isArray(items) ? items : (items?.PipelineItems || []);
  const item = pipelineItems.find(i => i?.PipelineId === pipelineId);

  if (item && newProspectStatusId) {
    await callLacrm('EditPipelineItem', {
      PipelineItemId: item.PipelineItemId,
      StatusId: newProspectStatusId,
    });
  }

  await logFollowupAction({
    contactId,
    companyName,
    actionType: 'skip_command',
    actionDetail: 'Skipped via WhatsApp — returned to New Prospect',
    triggeredBy: 'whatsapp',
  });

  return `⏭️ *${companyName}* → back to New Prospect\nWill be included in next route planning.`;
}

function cmdHelp() {
  return [
    '🤖 *Zoom Drain Commands*',
    '',
    '*DONE* [name] — Mark drop-in complete',
    '*NOTE* [name] | [text] — Add a note',
    '*APPROVE* [id] — Send queued message',
    '*APPROVE ALL* — Send all queued',
    '*REJECT* [id] — Cancel queued message',
    '*QUEUE* — List pending messages',
    '*STATUS* — Pipeline summary',
    '*NEXT* — Today\'s stops',
    '*SKIP* [name] — Skip, reschedule',
    '*HELP* — This message',
  ].join('\n');
}

// =============================================================================
// Execute an approved queue item
// =============================================================================

async function executeApprovedAction(item) {
  try {
    if (item.channel === 'sms') {
      // External SMS to restaurant
      await sendExternalSms(item.recipient, item.body);

      await logFollowupAction({
        contactId: item.contact_id,
        companyName: item.company_name,
        actionType: item.action_type,
        actionDetail: `Sent after approval #${item.id}`,
        triggeredBy: 'approval',
        metadata: { queueId: item.id, recipient: item.recipient },
      });

      return `📤 Text sent to ${item.recipient}`;
    }

    if (item.channel === 'email') {
      return `📧 Email draft saved in LACRM notes`;
    }

    return '✅ Action logged';
  } catch (err) {
    console.error(`[Approval] Execute failed for #${item.id}:`, err.message);
    return `❌ Send failed: ${err.message}`;
  }
}

export default router;
