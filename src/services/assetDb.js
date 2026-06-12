import pg from 'pg';
import crypto from 'crypto';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

export async function initAssetDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS assets (
      id                  TEXT PRIMARY KEY,
      asset_type          TEXT NOT NULL,
      notes               TEXT,
      -- Customer info (cached from Service Titan)
      customer_id         TEXT,
      customer_name       TEXT,
      customer_phone      TEXT,
      customer_email      TEXT,
      -- Location info
      location_id         TEXT,
      location_address    TEXT,
      location_name       TEXT,
      -- Service Titan equipment record
      st_equipment_id     TEXT,
      -- Registration metadata
      registered_by_phone TEXT,
      registered_at       TIMESTAMPTZ DEFAULT NOW(),
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS asset_authorized_phones (
      id         SERIAL PRIMARY KEY,
      phone      TEXT NOT NULL UNIQUE,   -- E.164 format
      name       TEXT,
      active     BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS asset_otp_sessions (
      id         SERIAL PRIMARY KEY,
      phone      TEXT NOT NULL,
      asset_id   TEXT NOT NULL,
      otp_code   TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used       BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS asset_reg_sessions (
      id         SERIAL PRIMARY KEY,
      token      TEXT NOT NULL UNIQUE,
      phone      TEXT NOT NULL,
      asset_id   TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  console.log('Asset database initialized');
}

// Normalize any phone format to E.164 (+1XXXXXXXXXX for US numbers)
export function normalizePhone(raw) {
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

// Seed authorized phones from ASSET_AUTHORIZED_PHONES env var (comma-separated E.164)
export async function seedAuthorizedPhones() {
  const raw = process.env.ASSET_AUTHORIZED_PHONES || '';
  if (!raw.trim()) return;
  const phones = raw.split(',').map(p => p.trim()).filter(Boolean);
  for (const phone of phones) {
    const normalized = normalizePhone(phone);
    await pool.query(
      `INSERT INTO asset_authorized_phones (phone, name)
       VALUES ($1, 'Admin')
       ON CONFLICT (phone) DO NOTHING`,
      [normalized]
    );
  }
  console.log(`Asset authorized phones seeded: ${phones.length}`);
}

export async function isAuthorizedPhone(phone) {
  const normalized = normalizePhone(phone);
  const result = await pool.query(
    'SELECT id FROM asset_authorized_phones WHERE phone = $1 AND active = TRUE',
    [normalized]
  );
  return result.rows.length > 0;
}

// Create an OTP for this phone+asset. Invalidates any prior unused OTPs first.
// Returns the plaintext OTP code (caller sends it via SMS).
export async function createOtpSession(phone, assetId) {
  const normalized = normalizePhone(phone);
  // Invalidate prior unused OTPs for this phone+asset combo
  await pool.query(
    `UPDATE asset_otp_sessions SET used = TRUE
     WHERE phone = $1 AND asset_id = $2 AND used = FALSE`,
    [normalized, assetId]
  );
  const otp = crypto.randomInt(100000, 1000000).toString(); // always 6 digits
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
  await pool.query(
    `INSERT INTO asset_otp_sessions (phone, asset_id, otp_code, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [normalized, assetId, otp, expiresAt]
  );
  return otp;
}

// Verify and consume an OTP. Returns true on success, false on invalid/expired.
export async function verifyOtp(phone, otp, assetId) {
  const normalized = normalizePhone(phone);
  const result = await pool.query(
    `SELECT id FROM asset_otp_sessions
     WHERE phone = $1 AND asset_id = $2 AND otp_code = $3
       AND used = FALSE AND expires_at > NOW()`,
    [normalized, assetId, otp]
  );
  if (result.rows.length === 0) return false;
  await pool.query(
    'UPDATE asset_otp_sessions SET used = TRUE WHERE id = $1',
    [result.rows[0].id]
  );
  return true;
}

// Create a 1-hour registration session after OTP is verified.
// Returns the session token (stored in an httpOnly cookie by the caller).
export async function createRegSession(phone, assetId) {
  const normalized = normalizePhone(phone);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  await pool.query(
    `INSERT INTO asset_reg_sessions (token, phone, asset_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [token, normalized, assetId, expiresAt]
  );
  return token;
}

// Verify a registration session token for a specific asset.
// Returns the phone number if valid, null if not.
export async function verifyRegSession(token, assetId) {
  if (!token) return null;
  const result = await pool.query(
    `SELECT phone FROM asset_reg_sessions
     WHERE token = $1 AND asset_id = $2 AND expires_at > NOW()`,
    [token, assetId]
  );
  return result.rows[0]?.phone || null;
}

export async function getAsset(id) {
  const result = await pool.query('SELECT * FROM assets WHERE id = $1', [id]);
  return result.rows[0] || null;
}

export async function createAsset(data) {
  const {
    id, asset_type, notes,
    customer_id, customer_name, customer_phone, customer_email,
    location_id, location_address, location_name,
    st_equipment_id, registered_by_phone,
  } = data;

  const result = await pool.query(
    `INSERT INTO assets (
       id, asset_type, notes,
       customer_id, customer_name, customer_phone, customer_email,
       location_id, location_address, location_name,
       st_equipment_id, registered_by_phone
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (id) DO UPDATE SET
       asset_type          = EXCLUDED.asset_type,
       notes               = EXCLUDED.notes,
       customer_id         = EXCLUDED.customer_id,
       customer_name       = EXCLUDED.customer_name,
       customer_phone      = EXCLUDED.customer_phone,
       customer_email      = EXCLUDED.customer_email,
       location_id         = EXCLUDED.location_id,
       location_address    = EXCLUDED.location_address,
       location_name       = EXCLUDED.location_name,
       st_equipment_id     = EXCLUDED.st_equipment_id,
       registered_by_phone = EXCLUDED.registered_by_phone,
       updated_at          = NOW()
     RETURNING *`,
    [id, asset_type, notes, customer_id, customer_name, customer_phone, customer_email,
     location_id, location_address, location_name, st_equipment_id, registered_by_phone]
  );
  return result.rows[0];
}
