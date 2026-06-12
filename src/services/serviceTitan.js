/**
 * Service Titan API client
 *
 * Required env vars (set after completing app registration):
 *   ST_CLIENT_ID       — from tenant Settings > Integrations > API Application Access
 *   ST_CLIENT_SECRET   — same location (click "Generate")
 *   ST_APP_KEY         — from developer.servicetitan.io, your app's Keys section
 *   ST_TENANT_ID       — your ServiceTitan tenant ID
 *
 * Until credentials are configured, all functions return mock data and log a warning.
 *
 * Auth flow: OAuth 2.0 client credentials → 15-min access token
 * Docs: https://developer.servicetitan.io/docs/oauth20/
 */

const ST_TOKEN_URL = 'https://auth.servicetitan.io/connect/token';
const ST_API_BASE  = 'https://api.servicetitan.io';

let tokenCache = { token: null, expiresAt: 0 };

function isConfigured() {
  return !!(
    process.env.ST_CLIENT_ID &&
    process.env.ST_CLIENT_SECRET &&
    process.env.ST_APP_KEY &&
    process.env.ST_TENANT_ID
  );
}

async function getToken() {
  // Return cached token if it has more than 30s remaining
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 30_000) {
    return tokenCache.token;
  }
  const res = await fetch(ST_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     process.env.ST_CLIENT_ID,
      client_secret: process.env.ST_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`ST auth failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  tokenCache.token     = data.access_token;
  tokenCache.expiresAt = Date.now() + data.expires_in * 1000;
  return tokenCache.token;
}

// Authenticated fetch against the tenant-scoped API
async function stFetch(path, options = {}) {
  const token = await getToken();
  const url   = `${ST_API_BASE}/v2/tenant/${process.env.ST_TENANT_ID}${path}`;
  const res   = await fetch(url, {
    ...options,
    headers: {
      Authorization:  `Bearer ${token}`,
      'ST-App-Key':   process.env.ST_APP_KEY,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ST API ${res.status}: ${body}`);
  }
  return res.json();
}

// ─── Mock data (used when credentials are not yet configured) ─────────────────

const MOCK_CUSTOMERS = [
  {
    id: 'mock-cust-1',
    name: "Chipotle Mexican Grill - Gilbert",
    phone: '(480) 555-0101',
    email: 'mgr.gilbert@chipotle.example.com',
  },
  {
    id: 'mock-cust-2',
    name: "Chili's Grill & Bar - Chandler",
    phone: '(480) 555-0202',
    email: 'ops@chilis-chandler.example.com',
  },
  {
    id: 'mock-cust-3',
    name: 'Red Robin - Mesa',
    phone: '(480) 555-0303',
    email: 'manager@redrobin-mesa.example.com',
  },
  {
    id: 'mock-cust-4',
    name: 'Olive Garden - Queen Creek',
    phone: '(480) 555-0404',
    email: 'qc@olivegarden.example.com',
  },
];

const MOCK_LOCATIONS = {
  'mock-cust-1': [{ id: 'mock-loc-1a', name: 'Main Kitchen', address: '2847 S Gilbert Rd, Gilbert, AZ 85295' }],
  'mock-cust-2': [{ id: 'mock-loc-2a', name: 'Kitchen', address: '1234 N Chandler Blvd, Chandler, AZ 85225' }],
  'mock-cust-3': [
    { id: 'mock-loc-3a', name: 'Main Kitchen', address: '5678 E Main St, Mesa, AZ 85201' },
    { id: 'mock-loc-3b', name: 'Bar Area',     address: '5678 E Main St, Mesa, AZ 85201' },
  ],
  'mock-cust-4': [{ id: 'mock-loc-4a', name: 'Kitchen', address: '21435 S Ellsworth Rd, Queen Creek, AZ 85142' }],
};

const MOCK_HISTORY = [
  {
    id: 'mock-job-1',
    date: '2026-03-15',
    type: 'Grease Trap Pumping',
    technician: 'Mike R.',
    notes: 'Pumped 300 gallons. Trap was 60% full on arrival. Recommended 90-day service interval.',
    invoice: 'INV-1042',
  },
  {
    id: 'mock-job-2',
    date: '2025-12-10',
    type: 'Mainline Jetting',
    technician: 'Dave W.',
    notes: 'Camera-verified clear after two passes. Minor grease buildup near trap outlet. Cleared.',
    invoice: 'INV-0887',
  },
];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Search customers by name. Returns simplified customer objects.
 * Used for the registration form autocomplete.
 */
export async function searchCustomers(query) {
  if (!isConfigured()) {
    console.warn('[ServiceTitan] Credentials not configured — returning mock customers');
    const q = query.toLowerCase();
    return MOCK_CUSTOMERS.filter(c => c.name.toLowerCase().includes(q));
  }
  // TODO: confirm exact query parameter name; ST CRM docs show 'name' filter
  const data = await stFetch(
    `/crm/v2/customers?name=${encodeURIComponent(query)}&pageSize=15&active=true`
  );
  return (data.data || []).map(c => ({
    id:    String(c.id),
    name:  c.name,
    phone: c.mobilePhone || c.homePhone || c.workPhone || '',
    email: c.email || '',
  }));
}

/**
 * Get service locations for a customer.
 * Used to populate the location dropdown after a customer is selected.
 */
export async function getCustomerLocations(customerId) {
  if (!isConfigured()) {
    console.warn('[ServiceTitan] Credentials not configured — returning mock locations');
    return MOCK_LOCATIONS[customerId] || [];
  }
  const data = await stFetch(
    `/crm/v2/locations?customerId=${encodeURIComponent(customerId)}&pageSize=50&active=true`
  );
  return (data.data || []).map(l => ({
    id:      String(l.id),
    name:    l.name || '',
    address: [l.address?.street, l.address?.city, l.address?.state, l.address?.zip]
               .filter(Boolean).join(', '),
  }));
}

/**
 * Create an installed equipment record in Service Titan.
 * Uses the QR asset ID as the serial number (prefix ZD-ASSET-) for cross-referencing.
 *
 * TODO: Map assetType strings to ST equipment type IDs (found in ST Settings > Equipment).
 * Until mapped, the equipment is created without a type ID.
 */
export async function createEquipment(assetId, assetType, customerId, locationId) {
  if (!isConfigured()) {
    console.warn('[ServiceTitan] Credentials not configured — skipping equipment creation');
    return { id: `mock-equip-${Date.now()}`, serialNumber: `ZD-ASSET-${assetId}` };
  }
  const payload = {
    installedOn:   new Date().toISOString(),
    serialNumber:  `ZD-ASSET-${assetId}`,
    name:          `${assetType} (Zoom Drain Asset #${assetId})`,
    locationId:    Number(locationId),
    // equipmentTypeId: TODO — map assetType to ST equipment type ID
    notes: `Registered via Zoom Drain Hub QR system. Asset ID: ${assetId}`,
  };
  // Endpoint: POST /equipmentsystems/v2/installed-equipment
  // Docs: https://developer.servicetitan.io/docs/api-resources-equipment-systems/
  const data = await stFetch('/equipmentsystems/v2/installed-equipment', {
    method: 'POST',
    body:   JSON.stringify(payload),
  });
  return { id: String(data.id), serialNumber: data.serialNumber };
}

/**
 * Get service history for a piece of equipment.
 * Queries jobs linked to the ST equipment record ID.
 *
 * TODO: Verify that field technicians record equipment on jobs in ST so records appear here.
 */
export async function getServiceHistory(stEquipmentId) {
  if (!isConfigured() || !stEquipmentId || stEquipmentId.startsWith('mock-')) {
    console.warn('[ServiceTitan] Credentials not configured — returning mock service history');
    return MOCK_HISTORY;
  }
  // TODO: confirm exact filter parameter for equipment ID in the jobs API
  const data = await stFetch(
    `/jpm/v2/jobs?installedEquipmentId=${encodeURIComponent(stEquipmentId)}&pageSize=50`
  );
  return (data.data || []).map(j => ({
    id:          String(j.id),
    date:        (j.completedOn || j.schedule?.scheduledDate || '').split('T')[0],
    type:        j.jobType?.name || 'Service',
    technician:  j.assignedTechnicians?.[0]?.name || 'Staff',
    notes:       j.summary || '',
    invoice:     j.invoiceNumber || '',
  }));
}
