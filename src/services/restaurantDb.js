/**
 * Restaurant Database Service
 * ============================
 * PostgreSQL schema and queries for the restaurant follow-up engine.
 * Tracks pipeline events, follow-up actions, and scheduled tasks.
 *
 * The restaurant prospects themselves live in LACRM (source of truth),
 * but we store follow-up state here because LACRM doesn't have
 * scheduling, cadence tracking, or event logging.
 */

import { pool } from './database.js';

// ── Schema ───────────────────────────────────────────────────────────────────

export const RESTAURANT_SCHEMA_SQL = `
  -- Pipeline stage change events (webhook log)
  CREATE TABLE IF NOT EXISTS restaurant_pipeline_events (
    id              SERIAL PRIMARY KEY,
    contact_id      TEXT NOT NULL,
    company_name    TEXT,
    old_status      TEXT,
    new_status      TEXT,
    pipeline_item_id TEXT,
    received_at     TIMESTAMPTZ DEFAULT NOW(),
    processed       BOOLEAN DEFAULT FALSE,
    actions_taken   JSONB DEFAULT '[]'
  );

  -- Follow-up actions (texts sent, tasks created, emails drafted)
  CREATE TABLE IF NOT EXISTS restaurant_followup_actions (
    id              SERIAL PRIMARY KEY,
    contact_id      TEXT NOT NULL,
    company_name    TEXT,
    action_type     TEXT NOT NULL,
    action_detail   TEXT,
    status          TEXT DEFAULT 'completed',
    triggered_by    TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    scheduled_for   TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    metadata        JSONB DEFAULT '{}'
  );

  -- Scheduled follow-up tasks (the cadence engine)
  CREATE TABLE IF NOT EXISTS restaurant_scheduled_tasks (
    id              SERIAL PRIMARY KEY,
    contact_id      TEXT NOT NULL,
    company_name    TEXT,
    task_type       TEXT NOT NULL,
    description     TEXT,
    due_date        DATE NOT NULL,
    status          TEXT DEFAULT 'pending',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    metadata        JSONB DEFAULT '{}'
  );

  -- Approval queue (messages waiting for Dave's review)
  CREATE TABLE IF NOT EXISTS restaurant_approval_queue (
    id              SERIAL PRIMARY KEY,
    contact_id      TEXT NOT NULL,
    company_name    TEXT,
    action_type     TEXT NOT NULL,
    channel         TEXT NOT NULL,
    recipient       TEXT,
    subject         TEXT,
    body            TEXT NOT NULL,
    status          TEXT DEFAULT 'pending',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    reviewed_at     TIMESTAMPTZ,
    triggered_by    TEXT,
    metadata        JSONB DEFAULT '{}'
  );

  -- Create indexes for common queries
  CREATE INDEX IF NOT EXISTS idx_pipeline_events_contact
    ON restaurant_pipeline_events(contact_id);
  CREATE INDEX IF NOT EXISTS idx_pipeline_events_received
    ON restaurant_pipeline_events(received_at DESC);
  CREATE INDEX IF NOT EXISTS idx_followup_actions_contact
    ON restaurant_followup_actions(contact_id);
  CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due
    ON restaurant_scheduled_tasks(due_date, status);
  CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_contact
    ON restaurant_scheduled_tasks(contact_id);
  CREATE INDEX IF NOT EXISTS idx_approval_queue_status
    ON restaurant_approval_queue(status, created_at DESC);
`;

// ── Pipeline Events ──────────────────────────────────────────────────────────

export async function logPipelineEvent(event) {
  const { rows } = await pool.query(`
    INSERT INTO restaurant_pipeline_events
      (contact_id, company_name, old_status, new_status, pipeline_item_id, actions_taken)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `, [
    event.contactId,
    event.companyName || '',
    event.oldStatus || '',
    event.newStatus || '',
    event.pipelineItemId || '',
    JSON.stringify(event.actionsTaken || []),
  ]);
  return rows[0];
}

export async function markEventProcessed(eventId, actions) {
  await pool.query(`
    UPDATE restaurant_pipeline_events
    SET processed = TRUE, actions_taken = $2
    WHERE id = $1
  `, [eventId, JSON.stringify(actions)]);
}

// ── Follow-up Actions ────────────────────────────────────────────────────────

export async function logFollowupAction(action) {
  const { rows } = await pool.query(`
    INSERT INTO restaurant_followup_actions
      (contact_id, company_name, action_type, action_detail, status, triggered_by, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `, [
    action.contactId,
    action.companyName || '',
    action.actionType,
    action.actionDetail || '',
    action.status || 'completed',
    action.triggeredBy || 'webhook',
    JSON.stringify(action.metadata || {}),
  ]);
  return rows[0];
}

export async function getRecentActions(limit = 50) {
  const { rows } = await pool.query(`
    SELECT * FROM restaurant_followup_actions
    ORDER BY created_at DESC LIMIT $1
  `, [limit]);
  return rows;
}

export async function getActionsForContact(contactId) {
  const { rows } = await pool.query(`
    SELECT * FROM restaurant_followup_actions
    WHERE contact_id = $1 ORDER BY created_at DESC
  `, [contactId]);
  return rows;
}

// ── Scheduled Tasks ──────────────────────────────────────────────────────────

export async function createScheduledTask(task) {
  const { rows } = await pool.query(`
    INSERT INTO restaurant_scheduled_tasks
      (contact_id, company_name, task_type, description, due_date, metadata)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `, [
    task.contactId,
    task.companyName || '',
    task.taskType,
    task.description || '',
    task.dueDate,
    JSON.stringify(task.metadata || {}),
  ]);
  return rows[0];
}

export async function getTasksDueBefore(date) {
  const { rows } = await pool.query(`
    SELECT * FROM restaurant_scheduled_tasks
    WHERE due_date <= $1 AND status = 'pending'
    ORDER BY due_date ASC
  `, [date]);
  return rows;
}

export async function getOverdueTasks() {
  const { rows } = await pool.query(`
    SELECT * FROM restaurant_scheduled_tasks
    WHERE due_date < CURRENT_DATE AND status = 'pending'
    ORDER BY due_date ASC
  `);
  return rows;
}

export async function getTasksThisWeek() {
  const { rows } = await pool.query(`
    SELECT * FROM restaurant_scheduled_tasks
    WHERE due_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '7 days')
      AND status = 'pending'
    ORDER BY due_date ASC
  `);
  return rows;
}

export async function completeTask(taskId) {
  await pool.query(`
    UPDATE restaurant_scheduled_tasks
    SET status = 'completed', completed_at = NOW()
    WHERE id = $1
  `, [taskId]);
}

// ── Approval Queue ───────────────────────────────────────────────────────────

export async function queueForApproval(item) {
  const { rows } = await pool.query(`
    INSERT INTO restaurant_approval_queue
      (contact_id, company_name, action_type, channel, recipient, subject, body, triggered_by, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *
  `, [
    item.contactId,
    item.companyName || '',
    item.actionType,
    item.channel || 'sms',
    item.recipient || '',
    item.subject || '',
    item.body,
    item.triggeredBy || 'webhook',
    JSON.stringify(item.metadata || {}),
  ]);
  return rows[0];
}

export async function getPendingApprovals(limit = 20) {
  const { rows } = await pool.query(`
    SELECT * FROM restaurant_approval_queue
    WHERE status = 'pending'
    ORDER BY created_at ASC LIMIT $1
  `, [limit]);
  return rows;
}

export async function getApprovalById(id) {
  const { rows } = await pool.query(`
    SELECT * FROM restaurant_approval_queue WHERE id = $1
  `, [id]);
  return rows[0] || null;
}

export async function approveQueueItem(id) {
  const { rows } = await pool.query(`
    UPDATE restaurant_approval_queue
    SET status = 'approved', reviewed_at = NOW()
    WHERE id = $1 AND status = 'pending'
    RETURNING *
  `, [id]);
  return rows[0] || null;
}

export async function rejectQueueItem(id) {
  const { rows } = await pool.query(`
    UPDATE restaurant_approval_queue
    SET status = 'rejected', reviewed_at = NOW()
    WHERE id = $1 AND status = 'pending'
    RETURNING *
  `, [id]);
  return rows[0] || null;
}

export async function getQueueStats() {
  const { rows: [stats] } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending')  AS pending,
      COUNT(*) FILTER (WHERE status = 'approved')  AS approved,
      COUNT(*) FILTER (WHERE status = 'rejected')  AS rejected,
      COUNT(*) AS total
    FROM restaurant_approval_queue
  `);
  return stats;
}

// ── Dashboard Stats ──────────────────────────────────────────────────────────

export async function getFollowupStats() {
  const { rows: [stats] } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM restaurant_pipeline_events) AS total_events,
      (SELECT COUNT(*) FROM restaurant_pipeline_events
       WHERE received_at > NOW() - INTERVAL '7 days') AS events_this_week,
      (SELECT COUNT(*) FROM restaurant_followup_actions) AS total_actions,
      (SELECT COUNT(*) FROM restaurant_followup_actions
       WHERE action_type = 'sms_thankyou') AS texts_sent,
      (SELECT COUNT(*) FROM restaurant_followup_actions
       WHERE action_type = 'email_draft') AS emails_drafted,
      (SELECT COUNT(*) FROM restaurant_followup_actions
       WHERE action_type = 'lacrm_task') AS tasks_created,
      (SELECT COUNT(*) FROM restaurant_scheduled_tasks
       WHERE status = 'pending') AS pending_tasks,
      (SELECT COUNT(*) FROM restaurant_scheduled_tasks
       WHERE due_date < CURRENT_DATE AND status = 'pending') AS overdue_tasks
  `);
  return stats;
}
