/**
 * LACRM API Client
 * ==================
 * Mirrors the call_lacrm() helper used across all four Python scripts.
 * Handles auth, rate-limit retries, and error normalization.
 *
 * All functions use process.env.LACRM_API_KEY — no config object needed.
 */

const LACRM_API_URL = 'https://api.lessannoyingcrm.com/v2/';

// ── Core request helper ───────────────────────────────────────────────────────

export async function callLacrm(functionName, parameters = {}) {
  const apiKey = process.env.LACRM_API_KEY;
  if (!apiKey) throw new Error('LACRM_API_KEY is not set');

  let attempts = 0;
  while (attempts < 4) {
    attempts++;

    const res = await fetch(LACRM_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  apiKey,
      },
      body: JSON.stringify({ Function: functionName, Parameters: parameters }),
    });

    if (res.status === 429) {
      console.warn(`[LACRM] Rate limited on ${functionName}, waiting 5s...`);
      await sleep(5000);
      continue;
    }

    const data = await res.json();

    if (res.status === 400) {
      return {
        error:      data.ErrorDescription || 'LACRM error',
        error_code: data.ErrorCode || '',
      };
    }

    return data;
  }

  return { error: 'Max retries exceeded' };
}

// ── Company search (mirrors search_company() from import_to_lacrm_v3.py) ─────

/**
 * Search LACRM for an existing company by name.
 * Tries multiple strategies to handle name variations and address suffixes.
 * Returns ContactId or null if not found.
 */
export async function findCompanyByName(name) {
  if (!name) return null;

  // Build a list of progressively simpler search terms
  const baseName   = name.split('(')[0].trim();
  const simpleName = baseName.replace(/[^\w\s]/g, '').trim();
  const shortName  = simpleName.split(/\s+/).slice(0, 2).join(' ');

  const queries = [...new Set([name, baseName, simpleName, shortName].filter(Boolean))];

  for (const query of queries) {
    const result = await callLacrm('GetContacts', { SearchTerms: query });
    const contacts =
      result?.Results ||
      result?.Contacts ||
      (Array.isArray(result) ? result : []);

    const found = matchContact(contacts, name);
    if (found) return found;
  }

  return null;
}

function matchContact(contacts, targetName) {
  const target     = targetName.toLowerCase().trim();
  const targetBase = target.split('(')[0].trim();

  for (const c of contacts) {
    if (!c?.IsCompany) continue;
    const comp     = (c.CompanyName || c['Company Name'] || c.Name || '').toLowerCase().trim();
    const compBase = comp.split('(')[0].trim();

    if (
      comp === target ||
      comp === targetBase ||
      compBase === target ||
      compBase === targetBase ||
      (targetBase.length >= 5 && (targetBase.includes(compBase) || compBase.includes(targetBase)))
    ) {
      return c.ContactId;
    }
  }
  return null;
}

// ── Pipeline / Group helpers (mirrors ensure_pipeline / ensure_group) ─────────

export async function ensurePipelineItem(contactId) {
  const pipelineId = process.env.LACRM_PIPELINE_ID;
  const statusId   = process.env.LACRM_NEW_PROSPECT_STATUS_ID;
  if (!pipelineId) return false;

  const check = await callLacrm('GetPipelineItemsAttachedToContact', { ContactId: contactId });
  const items = Array.isArray(check) ? check : (check?.PipelineItems || []);
  if (items.some(i => i?.PipelineId === pipelineId)) return true;   // already exists

  const result = await callLacrm('CreatePipelineItem', {
    ContactId:  contactId,
    PipelineId: pipelineId,
    StatusId:   statusId,
    Note:       `Auto-imported on ${today()}`,
  });

  return !!result?.PipelineItemId;
}

export async function ensureGroupMembership(contactId) {
  const groupId = process.env.LACRM_GROUP_ID;
  if (!groupId) return;
  await callLacrm('CreateGroupMembership', { ContactId: contactId, GroupId: groupId });
}

export async function setCustomFields(contactId, prospect) {
  const fields = {};
  const map = {
    place_id:     'Place ID',
    icp_score:    'ICP Score',
    grease_score: 'Grease Score',
    rating:       'Google Rating',
    review_count: 'Review Count',
    cuisine_type: 'Cuisine Type',
    latitude:     'Latitude',
    longitude:    'Longitude',
  };

  for (const [key, lacrmField] of Object.entries(map)) {
    const val = prospect[key];
    if (val !== undefined && val !== null && String(val) !== '') {
      fields[lacrmField] = String(val);
    }
  }

  if (Object.keys(fields).length === 0) return;
  await callLacrm('EditContact', { ContactId: contactId, ...fields });
}

// ── Paginated pipeline item loader (mirrors get_prospects_from_lacrm()) ───────

export async function getPipelineItems(pipelineId) {
  const items = [];
  let page = 1;

  while (true) {
    const result = await callLacrm('GetPipelineItems', { PipelineId: pipelineId, Page: page });
    if (!result) break;

    const batch = result.Results || result.PipelineItems || (Array.isArray(result) ? result : []);
    if (!Array.isArray(batch) || batch.length === 0) break;

    items.push(...batch);

    if (!result.HasMoreResults) break;
    page++;
    await sleep(300);
  }

  return items;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function today() { return new Date().toISOString().split('T')[0]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
