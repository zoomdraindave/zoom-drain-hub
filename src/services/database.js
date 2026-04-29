import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

// Create tables if they don't exist
export async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id            TEXT PRIMARY KEY,
      received_at   TIMESTAMPTZ DEFAULT NOW(),
      source        TEXT DEFAULT 'angi',

      -- Customer info
      customer_name  TEXT,
      customer_phone TEXT,
      customer_email TEXT,

      -- Job info
      job_type       TEXT,
      job_description TEXT,
      job_address    TEXT,

      -- Claude analysis
      urgency        TEXT,
      score          INTEGER,
      estimated_value TEXT,
      phone_summary  TEXT,
      recommended_action TEXT,
      flags          TEXT[],

      -- Call tracking
      status         TEXT DEFAULT 'new',
      call_sid       TEXT,
      call_initiated_at TIMESTAMPTZ,
      call_status    TEXT,
      call_duration  INTEGER,
      connected_at   TIMESTAMPTZ,
      skipped_at     TIMESTAMPTZ,
      sms_sent_at    TIMESTAMPTZ,

      -- Raw data
      raw_payload    JSONB,
      raw_analysis   JSONB
    );

    CREATE TABLE IF NOT EXISTS call_events (
      id          SERIAL PRIMARY KEY,
      lead_id     TEXT REFERENCES leads(id),
      call_sid    TEXT,
      event_type  TEXT,
      event_data  JSONB,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('Database initialized');
}

// ── Lead operations ──────────────────────────────────────

export async function createLead(lead, analysis) {
  const result = await pool.query(`
    INSERT INTO leads (
      id, customer_name, customer_phone, customer_email,
      job_type, job_description, job_address,
      urgency, score, estimated_value, phone_summary,
      recommended_action, flags,
      raw_payload, raw_analysis
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12, $13,
      $14, $15
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING *
  `, [
    lead.id,
    lead.contact?.name,
    lead.contact?.phone,
    lead.contact?.email,
    analysis.job_type,
    lead.job?.description,
    lead.job?.fullAddress,
    analysis.urgency,
    analysis.score,
    analysis.estimated_value,
    analysis.phone_summary,
    analysis.recommended_action,
    analysis.flags || [],
    JSON.stringify(lead.raw || lead),   // store original Angi payload
    JSON.stringify(analysis),
  ]);
  return result.rows[0];
}

export async function updateLeadCall(leadId, callSid) {
  await pool.query(`
    UPDATE leads
    SET status = 'called',
        call_sid = $2,
        call_initiated_at = NOW()
    WHERE id = $1
  `, [leadId, callSid]);
}

export async function updateLeadStatus(callSid, status, extraFields = {}) {
  const setClauses = ['status = $2'];
  const values = [callSid, status];
  let i = 3;

  if (status === 'connected') {
    setClauses.push(`connected_at = NOW()`);
  } else if (status === 'skipped') {
    setClauses.push(`skipped_at = NOW()`);
  } else if (status === 'sms_sent') {
    setClauses.push(`sms_sent_at = NOW()`);
  }

  for (const [key, val] of Object.entries(extraFields)) {
    setClauses.push(`${key} = $${i++}`);
    values.push(val);
  }

  await pool.query(`
    UPDATE leads
    SET ${setClauses.join(', ')}
    WHERE call_sid = $1
  `, values);
}

export async function updateCallStatus(callSid, callStatus, duration) {
  await pool.query(`
    UPDATE leads
    SET call_status = $2,
        call_duration = $3
    WHERE call_sid = $1
  `, [callSid, callStatus, duration || 0]);
}

export async function getLeadByCallSid(callSid) {
  const result = await pool.query(
    'SELECT * FROM leads WHERE call_sid = $1',
    [callSid]
  );
  return result.rows[0] || null;
}

export async function logCallEvent(leadId, callSid, eventType, eventData) {
  await pool.query(`
    INSERT INTO call_events (lead_id, call_sid, event_type, event_data)
    VALUES ($1, $2, $3, $4)
  `, [leadId, callSid, eventType, JSON.stringify(eventData)]);
}

export async function getRecentLeads(limit = 50) {
  const result = await pool.query(`
    SELECT * FROM leads
    ORDER BY received_at DESC
    LIMIT $1
  `, [limit]);
  return result.rows;
}

export { pool };