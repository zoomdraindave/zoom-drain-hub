/**
 * Restaurant Prospect System — Express Routes
 * =============================================
 * Converts all four Python scripts into Express endpoints.
 * LACRM is the only data store — no Postgres involved.
 *
 * ENDPOINTS
 *   POST /restaurants/discover        discover_restaurants_v2.py
 *   POST /restaurants/import          import_to_lacrm_v3.py
 *   POST /restaurants/enrich          enrich_prospects.py
 *   POST /restaurants/plan-routes     plan_routes.py
 *
 * AUTH
 *   All endpoints require the same header the rest of the hub uses:
 *   x-api-key: <ANGI_API_KEY>
 *
 * ASYNC PATTERN
 *   POST /discover and POST /import return 202 immediately and run in the
 *   background — same pattern as the Angi webhook handler in angi.js.
 *   POST /enrich and POST /plan-routes respond synchronously.
 */

import { Router }   from 'express';
import Anthropic    from '@anthropic-ai/sdk';
import {
  callLacrm,
  findCompanyByName,
  ensurePipelineItem,
  ensureGroupMembership,
  setCustomFields,
  getPipelineItems,
} from '../services/lacrmClient.js';
import {
  searchRestaurants,
  deduplicateProspects,
} from '../services/googlePlaces.js';

const router = Router();

// ── Auth (same x-api-key check as the rest of the hub) ───────────────────────

router.use((req, res, next) => {
  const key = req.headers['x-api-key'] || req.query.key;
  if (!key || key !== process.env.ANGI_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// =============================================================================
// POST /restaurants/discover
// Mirrors discover_restaurants_v2.py
//
// Searches Google Places across cities and cuisine types, deduplicates, and
// returns the sorted prospect list. Does NOT write to LACRM — that's /import.
//
// Body (all optional — defaults match config.json values):
//   cities        string[]  default: the 7 East Valley cities
//   cuisines      string[]  default: all 14 high-grease cuisine types
//   zipCodes      string[]  default: all configured zip codes
//   maxPages      number    1–3, default 3
//   minIcpScore   number    filter before returning, default 0
// =============================================================================

const DEFAULT_CITIES = [
  'Chandler, AZ', 'Mesa, AZ', 'Gilbert, AZ',
  'Queen Creek, AZ', 'Apache Junction, AZ', 'Gold Canyon, AZ', 'San Tan Valley, AZ',
];

const DEFAULT_CUISINES = [
  'BBQ restaurant', 'Mexican restaurant', 'Chinese restaurant', 'Thai restaurant',
  'Vietnamese restaurant', 'Indian restaurant', 'Italian restaurant',
  'Pizza restaurant', 'Fried chicken restaurant', 'Burger restaurant',
  'Seafood restaurant', 'Japanese restaurant', 'Korean restaurant',
  'Mediterranean restaurant',
];

const DEFAULT_ZIPS = [
  '85224', '85225', '85226', '85248', '85249', '85286',               // Chandler
  '85201', '85202', '85203', '85204', '85205', '85206',               // Mesa
  '85207', '85208', '85209', '85210', '85212', '85213', '85215',
  '85233', '85234', '85295', '85296', '85297', '85298',               // Gilbert
  '85142', '85120', '85140', '85143',                                  // QC / AJ / STV
];

router.post('/discover', async (req, res) => {
  res.status(202).json({
    message: 'Discovery started — this runs in the background and may take 20–40 minutes',
    tip: 'Results are returned to the caller that triggered /import next',
  });

  setImmediate(async () => {
    const {
      cities      = DEFAULT_CITIES,
      cuisines    = DEFAULT_CUISINES,
      zipCodes    = DEFAULT_ZIPS,
      maxPages    = 3,
      minIcpScore = 0,
    } = req.body || {};

    const allProspects = [];
    let searchCount = 0;

    try {
      // Phase 1 — General restaurant search per city
      console.log('[Discover] Phase 1: General search by city');
      for (const city of cities) {
        const results = await searchRestaurants('restaurants', city, maxPages);
        allProspects.push(...results);
        searchCount++;
        await sleep(1000);
      }

      // Phase 2 — Cuisine-specific deep search
      console.log('[Discover] Phase 2: High-grease cuisine search');
      for (const cuisine of cuisines) {
        for (const city of cities) {
          const results = await searchRestaurants(cuisine, city, maxPages);
          allProspects.push(...results);
          searchCount++;
          await sleep(500);
        }
      }

      // Phase 3 — Zip code sub-searches
      console.log('[Discover] Phase 3: Zip code deep search');
      for (const zip of zipCodes) {
        const results = await searchRestaurants('restaurants', zip, 2);
        allProspects.push(...results);
        searchCount++;
        // Top 5 high-grease cuisines per zip (mirrors Phase 3 in the Python script)
        for (const cuisine of cuisines.slice(0, 5)) {
          const r = await searchRestaurants(cuisine, zip, 1);
          allProspects.push(...r);
          searchCount++;
          await sleep(300);
        }
        await sleep(500);
      }

      // Phase 4 — Targeted searches
      console.log('[Discover] Phase 4: Targeted searches');
      const targeted = ['catering company', 'food hall', 'hotel restaurant', 'ghost kitchen'];
      for (const query of targeted) {
        for (const city of cities.slice(0, 4)) {
          const results = await searchRestaurants(query, city, 2);
          allProspects.push(...results);
          searchCount++;
          await sleep(500);
        }
      }

      const deduped  = deduplicateProspects(allProspects);
      const filtered = minIcpScore > 0
        ? deduped.filter(p => p.icp_score >= minIcpScore)
        : deduped;

      // Store on the module so /import can pick them up this session.
      // For persistent re-use across restarts, save to a JSON file (see below).
      latestDiscoveryResults = filtered;
      await saveDiscoveryJson(filtered);

      console.log(`[Discover] Done: ${filtered.length} prospects from ${searchCount} searches`);

    } catch (err) {
      console.error('[Discover] Fatal error:', err);
    }
  });
});

// In-memory cache of last discovery run (survives the request, not a restart)
let latestDiscoveryResults = null;

// =============================================================================
// POST /restaurants/import
// Mirrors import_to_lacrm_v3.py
//
// Takes the discovery results (from the in-memory cache or the saved JSON file)
// and pushes each prospect into LACRM as a Company with pipeline item, group
// membership, custom fields, and a profile note.
//
// Body (all optional):
//   minIcpScore   number    minimum ICP score to import (default 20)
//   limit         number    cap how many prospects to process this run
// =============================================================================

router.post('/import', async (req, res) => {
  const { minIcpScore = 20, limit = null } = req.body || {};

  // Load discovery results — in-memory first, then fall back to saved JSON
  let prospects = latestDiscoveryResults || (await loadDiscoveryJson());

  if (!prospects || prospects.length === 0) {
    return res.status(400).json({
      error: 'No discovery results found. Run POST /restaurants/discover first.',
    });
  }

  const qualified = prospects
    .filter(p => p.icp_score >= minIcpScore)
    .slice(0, limit || Infinity);

  res.status(202).json({
    message: `Importing ${qualified.length} prospects into LACRM in the background`,
    total:   qualified.length,
  });

  setImmediate(async () => {
    const userResult = await callLacrm('GetUser');
    if (!userResult?.UserId) {
      console.error('[Import] Could not get LACRM user — check LACRM_API_KEY');
      return;
    }
    const userId = userResult.UserId;
    const stats  = { imported: 0, repaired: 0, skipped: 0, failed: 0 };

    for (const prospect of qualified) {
      try {
        const outcome = await importOneProspect(prospect, userId);
        stats[outcome] = (stats[outcome] || 0) + 1;
      } catch (err) {
        console.error(`[Import] Unexpected error on "${prospect.name}":`, err.message);
        stats.failed++;
      }
      await sleep(300);
    }

    console.log('[Import] Complete:', stats);
  });
});

async function importOneProspect(prospect, userId) {
  const name = prospect.name;

  const createResult = await callLacrm('CreateContact', {
    IsCompany:      true,
    AssignedTo:     userId,
    'Company Name': name,
    Phone:   prospect.phone   ? [{ Text: prospect.phone,    Type: 'Work' }] : [],
    Website: prospect.website || '',
    Address: prospect.address ? [{ Street: prospect.address, Type: 'Work' }] : [],
  });

  let contactId = createResult?.ContactId;

  if (!contactId) {
    // Check whether the failure is a duplicate-name error
    const errMsg  = (createResult?.error || '').toLowerCase();
    const isDupe  = ['same name', 'already exists', 'duplicate', "can't have two"]
      .some(phrase => errMsg.includes(phrase));

    if (!isDupe) {
      console.warn(`[Import] ❌ Could not create "${name}": ${createResult?.error}`);
      return 'failed';
    }

    // Duplicate — find the existing record and repair pipeline/group/fields
    contactId = await findCompanyByName(name);
    if (!contactId) {
      console.warn(`[Import] ⚠️  Duplicate but not found in search: "${name}"`);
      return 'skipped';
    }

    await ensurePipelineItem(contactId);
    await ensureGroupMembership(contactId);
    await setCustomFields(contactId, prospect);
    console.log(`[Import] 🔧 Repaired: "${name}"`);
    return 'repaired';
  }

  // Fresh create — attach pipeline, group, custom fields, and profile note
  await ensurePipelineItem(contactId);
  await ensureGroupMembership(contactId);
  await setCustomFields(contactId, prospect);
  await callLacrm('CreateNote', {
    ContactId: contactId,
    Note:      buildProfileNote(prospect),
  });

  console.log(`[Import] ✅ "${name}" (ICP: ${prospect.icp_score}, Grease: ${prospect.grease_score})`);
  return 'imported';
}

function buildProfileNote(prospect) {
  return [
    '=== AUTO-GENERATED PROSPECT PROFILE ===',
    `Discovered: ${prospect.discovered_date || 'Unknown'}`,
    `Source: ${prospect.source || 'Google Places API'}`,
    '',
    '--- Business Info ---',
    `Name: ${prospect.name}`,
    `Address: ${prospect.address}`,
    `Phone: ${prospect.phone || 'Not found'}`,
    `Website: ${prospect.website || 'Not found'}`,
    `Google Maps: ${prospect.google_maps_url}`,
    '',
    '--- Scoring ---',
    `Cuisine Type: ${prospect.cuisine_type || 'Unknown'}`,
    `Grease Score: ${prospect.grease_score}/5`,
    `ICP Score: ${prospect.icp_score}/100`,
    `Google Rating: ${prospect.rating} (${prospect.review_count} reviews)`,
    '',
    '--- Next Steps ---',
    '1. Run POST /restaurants/enrich to generate AI talking points',
    '2. Run POST /restaurants/plan-routes to schedule a drop-in visit',
  ].join('\n');
}

// =============================================================================
// POST /restaurants/enrich
// Mirrors enrich_prospects.py
//
// Loads pipeline items from LACRM, scrapes each restaurant's website, pulls
// Google reviews, and calls Claude to generate owner name, talking points, and
// recommended approach. Posts an enrichment note back to each LACRM contact.
//
// Body (all optional):
//   limit    number    max prospects to enrich (default 20)
//   force    boolean   re-enrich contacts that already have an enrichment note
// =============================================================================

router.post('/enrich', async (req, res) => {
  const { limit = 20, force = false } = req.body || {};

  // Load pipeline items from LACRM to get contact IDs
  const pipelineId = process.env.LACRM_PIPELINE_ID;
  if (!pipelineId) {
    return res.status(400).json({ error: 'LACRM_PIPELINE_ID env var is not set' });
  }

  const allItems = await getPipelineItems(pipelineId);
  if (!allItems.length) {
    return res.status(404).json({ error: 'No pipeline items found in LACRM' });
  }

  console.log(`[Enrich] Found ${allItems.length} pipeline items — fetching contact details`);

  // Fetch contact details for each item, skip already-enriched unless force=true
  const prospects = [];
  for (const item of allItems) {
    if (prospects.length >= limit) break;
    const contactId = item.ContactId;
    if (!contactId) continue;

    const contact = await callLacrm('GetContact', { ContactId: contactId });
    if (!contact || contact.error) continue;

    // Skip if already enriched (look for enrichment note)
    if (!force) {
      const notes = Array.isArray(contact.Notes) ? contact.Notes : [];
      if (notes.some(n => (n.Note || '').includes('AI-ENRICHED'))) continue;
    }

    prospects.push(buildProspectFromContact(contact, item));
    await sleep(200);
  }

  if (!prospects.length) {
    return res.json({ message: 'All prospects already enriched. Use force: true to re-enrich.' });
  }

  res.json({
    message: `Enriching ${prospects.length} prospects`,
    count:   prospects.length,
  });

  // Process in small concurrent batches (mirrors ThreadPoolExecutor with workers=5)
  setImmediate(async () => {
    const BATCH = 3;
    const stats = { enriched: 0, noData: 0, failed: 0 };

    for (let i = 0; i < prospects.length; i += BATCH) {
      await Promise.all(
        prospects.slice(i, i + BATCH).map(p => enrichOne(p, stats))
      );
    }

    console.log('[Enrich] Complete:', stats);
  });
});

function buildProspectFromContact(contact, pipelineItem) {
  const phones   = Array.isArray(contact.Phone) ? contact.Phone : [];
  const addresses = Array.isArray(contact.Address) ? contact.Address : [];
  let website    = contact.Website || '';
  if (Array.isArray(website)) website = website[0]?.Text || '';

  // Read ICP/grease from LACRM custom fields (set during import)
  const tryFloat = v => { try { return parseFloat(v) || 0; } catch { return 0; } };

  return {
    contact_id:       contact.ContactId,
    pipeline_item_id: pipelineItem.PipelineItemId || '',
    name:             contact.CompanyName || contact['Company Name'] || '',
    phone:            phones[0]?.Text || '',
    website,
    address:          addresses[0]?.Street || '',
    place_id:         contact['Place ID'] || '',
    icp_score:        tryFloat(contact['ICP Score']),
    grease_score:     tryFloat(contact['Grease Score']),
    rating:           tryFloat(contact['Google Rating']),
    review_count:     parseInt(contact['Review Count']) || 0,
    cuisine_type:     contact['Cuisine Type'] || '',
  };
}

async function enrichOne(prospect, stats) {
  const name = prospect.name;
  try {
    const websiteData = await scrapeWebsite(prospect.website);
    const reviews     = await getGoogleReviews(prospect.place_id);
    const ownerFromReviews = extractOwnerFromReviews(reviews);

    if (!websiteData.text && !reviews.length) {
      console.log(`[Enrich] ⚠️  No data for "${name}"`);
      stats.noData++;
      return;
    }

    const enrichment = await callClaude(prospect, websiteData, reviews);
    if (!enrichment || enrichment.error) {
      console.error(`[Enrich] ❌ Claude error for "${name}":`, enrichment?.error);
      stats.failed++;
      return;
    }

    // Fall back to review-signature owner if Claude didn't find one
    if ((!enrichment.owner_name || enrichment.owner_name === 'Not identified') && ownerFromReviews) {
      enrichment.owner_name = ownerFromReviews;
    }

    await callLacrm('CreateNote', {
      ContactId: prospect.contact_id,
      Note:      buildEnrichmentNote(enrichment),
    });

    const ownerStr = enrichment.owner_name && enrichment.owner_name !== 'Not identified'
      ? ` | Owner: ${enrichment.owner_name}`
      : '';
    console.log(`[Enrich] ✅ "${name}"${ownerStr}`);
    stats.enriched++;

  } catch (err) {
    console.error(`[Enrich] ❌ "${name}":`, err.message);
    stats.failed++;
  }
}

// ── Website scraping (mirrors scrape_website() / BeautifulSoup in Python) ────

async function scrapeWebsite(url) {
  if (!url) return { text: '', aboutText: '' };
  if (!url.startsWith('http')) url = 'https://' + url;

  const result  = { text: '', aboutText: '' };
  const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; ZoomDrainBot/1.0)' };

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return result;

    const html = await res.text();
    result.text = stripHtml(html).slice(0, 4000);

    // Look for About/Team/Our Story pages
    const aboutLinks = [...html.matchAll(/href=["']([^"']*(?:about|our-story|team|history|who-we-are)[^"']*)/gi)]
      .map(m => m[1])
      .filter(Boolean)
      .slice(0, 2);

    for (const link of aboutLinks) {
      try {
        const aboutUrl = link.startsWith('http') ? link : new URL(link, url).href;
        const aboutRes = await fetch(aboutUrl, { headers, signal: AbortSignal.timeout(8000) });
        if (aboutRes.ok) {
          result.aboutText += stripHtml(await aboutRes.text()).slice(0, 1500) + '\n';
        }
      } catch { /* ignore individual page failures */ }
    }
  } catch (err) {
    // Network failures are common — log but don't throw
    console.warn(`[Scrape] "${url}": ${err.message}`);
  }

  return result;
}

function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Google Reviews (mirrors get_google_reviews()) ────────────────────────────

async function getGoogleReviews(placeId) {
  if (!placeId || !process.env.GOOGLE_API_KEY) return [];

  try {
    const res = await fetch(
      `https://places.googleapis.com/v1/places/${placeId}`,
      {
        headers: {
          'X-Goog-Api-Key':  process.env.GOOGLE_API_KEY,
          'X-Goog-FieldMask': 'reviews',
        },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!res.ok) return [];

    const data = await res.json();
    return (data.reviews || []).slice(0, 5).map(r => ({
      text:          r.text?.text || '',
      rating:        r.rating || 0,
      author:        r.authorAttribution?.displayName || '',
      ownerResponse: r.ownerResponse?.text || '',
    }));
  } catch {
    return [];
  }
}

// ── Owner name extraction from review response signatures ─────────────────────

function extractOwnerFromReviews(reviews) {
  const patterns = [
    /(?:thanks|thank you|cheers|regards)[,!\s\-—]+([A-Z][a-z]+ ?[A-Z]?[a-z]*)/i,
    /—\s*([A-Z][a-z]+ ?[A-Z]?[a-z]*)/,
    /-\s*([A-Z][a-z]+),?\s*(?:owner|manager|gm)/i,
  ];
  const skip  = new Set(['the', 'our', 'your', 'this', 'that', 'thank', 'thanks']);
  const names = [];

  for (const review of reviews) {
    for (const pattern of patterns) {
      const match = (review.ownerResponse || '').match(pattern);
      if (match?.[1]) {
        const name = match[1].trim();
        if (name.length > 2 && !skip.has(name.toLowerCase())) names.push(name);
      }
    }
  }

  if (!names.length) return null;
  const counts = {};
  for (const n of names) counts[n] = (counts[n] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

// ── Claude AI enrichment (mirrors enrich_with_claude()) ──────────────────────

async function callClaude(prospect, websiteData, reviews) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const reviewText = reviews
    .map(r => `- (${r.rating}★) ${r.text?.slice(0, 200)}`)
    .join('\n');
  const ownerResponses = reviews
    .filter(r => r.ownerResponse)
    .map(r => `- ${r.ownerResponse.slice(0, 200)}`)
    .join('\n');

  const prompt = `You are helping Zoom Drain (a drain and sewer service company) prepare for a sales drop-in visit.

RESTAURANT DATA:
- Name: ${prospect.name}
- Address: ${prospect.address}
- Phone: ${prospect.phone}
- Website: ${prospect.website}
- Google Rating: ${prospect.rating} (${prospect.review_count} reviews)
- Cuisine/Type: ${prospect.cuisine_type || 'Unknown'}
- Grease Score: ${prospect.grease_score}/5

WEBSITE CONTENT:
${(websiteData.text || 'No website content').slice(0, 3000)}

ABOUT PAGE:
${(websiteData.aboutText || 'No about page found').slice(0, 1500)}

GOOGLE REVIEWS:
${reviewText.slice(0, 2000) || 'No reviews available'}

OWNER RESPONSES TO REVIEWS:
${ownerResponses.slice(0, 1000) || 'None'}

Respond in this EXACT format — be concise and specific:

OWNER_NAME: [name or "Not identified" — do NOT guess]
BUSINESS_SUMMARY: [2-3 sentences on cuisine, vibe, how established]
KITCHEN_PROFILE: [1-2 sentences on likely drain needs for this cuisine type]
TALKING_POINT_1: [specific, references real details from website or reviews]
TALKING_POINT_2: [specific, references real details from website or reviews]
TALKING_POINT_3: [specific, references real details from website or reviews]
PAIN_POINT_1: [specific drain/grease concern for this restaurant]
PAIN_POINT_2: [specific drain/grease concern for this restaurant]
RECOMMENDED_APPROACH: [one sentence — jetting service, grease bundle, or full maintenance plan, and why]`;

  try {
    const response = await client.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages:   [{ role: 'user', content: prompt }],
    });
    return parseClaudeResponse(response.content[0].text);
  } catch (err) {
    return { error: err.message };
  }
}

function parseClaudeResponse(text) {
  const fields = {
    'OWNER_NAME':           'owner_name',
    'BUSINESS_SUMMARY':     'business_summary',
    'KITCHEN_PROFILE':      'kitchen_profile',
    'TALKING_POINT_1':      'talking_point_1',
    'TALKING_POINT_2':      'talking_point_2',
    'TALKING_POINT_3':      'talking_point_3',
    'PAIN_POINT_1':         'pain_point_1',
    'PAIN_POINT_2':         'pain_point_2',
    'RECOMMENDED_APPROACH': 'recommended_approach',
  };

  const result = {};
  for (const line of text.split('\n')) {
    for (const [key, field] of Object.entries(fields)) {
      if (line.toUpperCase().startsWith(key + ':')) {
        result[field] = line.slice(key.length + 1).trim();
        break;
      }
    }
  }
  return result;
}

function buildEnrichmentNote(e) {
  return [
    '=== AI-ENRICHED PROSPECT PROFILE ===',
    `Enriched: ${new Date().toISOString().split('T')[0]}`,
    'Source: Website scraping + Google Reviews + Claude AI',
    '',
    '--- Owner/Manager ---',
    `Name: ${e.owner_name || 'Not identified'}`,
    '',
    '--- Business Summary ---',
    e.business_summary || 'Not available',
    '',
    '--- Kitchen & Drain Profile ---',
    e.kitchen_profile || 'Not available',
    '',
    '--- Drop-In Talking Points ---',
    `1. ${e.talking_point_1 || 'N/A'}`,
    `2. ${e.talking_point_2 || 'N/A'}`,
    `3. ${e.talking_point_3 || 'N/A'}`,
    '',
    '--- Potential Pain Points ---',
    `1. ${e.pain_point_1 || 'N/A'}`,
    `2. ${e.pain_point_2 || 'N/A'}`,
    '',
    '--- Recommended Approach ---',
    e.recommended_approach || 'N/A',
  ].join('\n');
}

// =============================================================================
// POST /restaurants/plan-routes
// Mirrors plan_routes.py
//
// Loads prospects from the LACRM pipeline (New Prospect status), clusters them
// geographically, optimizes visit order, creates LACRM calendar events, and
// updates pipeline status to "Drop-In Scheduled".
//
// Body (all optional):
//   numOutings       number    routes to plan (default 2)
//   visitsPerOuting  number    stops per route (default 6)
//   maxRadiusMiles   number    cluster radius (default 8)
//   slot             string    "morning" | "afternoon" (default "morning")
//   preview          boolean   build routes but skip LACRM event creation
//   startDate        string    YYYY-MM-DD (default: next available Tue/Thu)
// =============================================================================

const BASE_LAT = () => parseFloat(process.env.BASE_LAT || '33.3062');
const BASE_LNG = () => parseFloat(process.env.BASE_LNG || '-111.8413');

const VISIT_SLOTS = {
  morning:   { hour: 9,  minute: 0 },
  afternoon: { hour: 14, minute: 0 },
};

router.post('/plan-routes', async (req, res) => {
  const {
    numOutings      = 2,
    visitsPerOuting = 6,
    maxRadiusMiles  = 8,
    slot            = 'morning',
    preview         = false,
    startDate       = null,
  } = req.body || {};

  const pipelineId = process.env.LACRM_PIPELINE_ID;
  if (!pipelineId) {
    return res.status(400).json({ error: 'LACRM_PIPELINE_ID env var is not set' });
  }

  try {
    // Load pipeline items and fetch contact details concurrently
    const allItems = await getPipelineItems(pipelineId);
    const newProspectStatusId = process.env.LACRM_NEW_PROSPECT_STATUS_ID;

    // Filter to "New Prospect" status only (mirrors plan_routes.py filter)
    const targetItems = newProspectStatusId
      ? allItems.filter(i => i.StatusId === newProspectStatusId)
      : allItems;

    if (!targetItems.length) {
      return res.status(404).json({ error: 'No "New Prospect" items found in pipeline' });
    }

    console.log(`[Routes] Loading contact details for ${targetItems.length} pipeline items`);

    // Fetch contact details in batches of 10
    const prospects = [];
    const BATCH = 10;
    for (let i = 0; i < targetItems.length; i += BATCH) {
      const batch = targetItems.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(item => fetchProspectDetail(item)));
      prospects.push(...results.filter(Boolean));
    }

    // Only route prospects that have coordinates
    const routable = prospects.filter(p => p.latitude && p.longitude);
    console.log(`[Routes] ${routable.length} of ${prospects.length} prospects have coordinates`);

    if (!routable.length) {
      return res.status(404).json({
        error: 'No prospects with coordinates found. Ensure prospects were imported from Google Places discovery.',
      });
    }

    // Build routes
    const routes = buildAllRoutes(routable, numOutings, visitsPerOuting, maxRadiusMiles);

    if (!routes.length) {
      return res.status(404).json({ error: 'Could not build any routes from available prospects' });
    }

    // Get visit dates (Tuesdays + Thursdays, starting tomorrow)
    const visitDates = getNextVisitDates(routes.length, startDate ? new Date(startDate) : null);

    const output = [];
    for (let i = 0; i < routes.length && i < visitDates.length; i++) {
      const route = routes[i];
      const date  = visitDates[i];

      if (!preview) {
        await scheduleRoute(route, date, slot);
      }

      output.push({
        date:       date.toISOString().split('T')[0],
        slot,
        area:       route.label,
        stops:      route.prospects.length,
        totalMiles: route.totalMiles,
        avgIcp:     route.avgIcp,
        itinerary:  route.prospects.map((p, idx) => ({
          stop:     idx + 1,
          name:     p.name,
          address:  p.address,
          phone:    p.phone,
          icpScore: p.icp_score,
          owner:    p.owner_name || null,
          driveMin: route.legs[idx]?.driveMin,
          miles:    route.legs[idx]?.miles,
        })),
      });
    }

    res.json({
      message: preview ? 'Preview — no LACRM events created' : 'Routes created and events added to LACRM calendar',
      outings: output,
    });

  } catch (err) {
    console.error('[Routes]', err);
    res.status(500).json({ error: err.message });
  }
});

async function fetchProspectDetail(pipelineItem) {
  try {
    const contact = await callLacrm('GetContact', { ContactId: pipelineItem.ContactId });
    if (!contact || contact.error) return null;

    const phones    = Array.isArray(contact.Phone)   ? contact.Phone   : [];
    const addresses = Array.isArray(contact.Address) ? contact.Address : [];
    let website     = contact.Website || '';
    if (Array.isArray(website)) website = website[0]?.Text || '';

    // Coordinates: try custom fields first, fall back to 0
    // (In a real deployment you'd store these during import — see note in INTEGRATION.md)
    const tryFloat = v => { try { return parseFloat(v) || 0; } catch { return 0; } };

    // Extract talking points from enrichment note if present
    let talkingPoints = {};
    const notes = Array.isArray(contact.Notes) ? contact.Notes : [];
    for (const n of notes) {
      if ((n.Note || '').includes('AI-ENRICHED')) {
        talkingPoints = parseTalkingPointsFromNote(n.Note);
        break;
      }
    }

    return {
      contact_id:       contact.ContactId,
      pipeline_item_id: pipelineItem.PipelineItemId || '',
      name:             contact.CompanyName || contact['Company Name'] || '',
      phone:            phones[0]?.Text || '',
      website,
      address:          addresses[0]?.Street || '',
      icp_score:        tryFloat(contact['ICP Score']),
      grease_score:     tryFloat(contact['Grease Score']),
        latitude:         tryFloat(contact['Latitude']),
      longitude:        tryFloat(contact['Longitude']),
      ...talkingPoints,
    };
  } catch {
    return null;
  }
}

function parseTalkingPointsFromNote(noteText) {
  const result = {};
  const patterns = {
    owner_name:         /Name:\s*(.+)/,
    talking_point_1:    /1\.\s*(.+)/,
    talking_point_2:    /2\.\s*(.+)/,
    talking_point_3:    /3\.\s*(.+)/,
    recommended_approach: /--- Recommended Approach ---\n(.+)/,
  };
  for (const [key, pattern] of Object.entries(patterns)) {
    const match = noteText.match(pattern);
    if (match?.[1]) result[key] = match[1].trim();
  }
  return result;
}

// ── Route building (mirrors plan_routes / build_route / optimize_visit_order) ─

function buildAllRoutes(prospects, numOutings, visitsPerOuting, maxRadius) {
  const sorted = [...prospects].sort((a, b) => b.icp_score - a.icp_score);
  const pool   = sorted.slice(0, numOutings * visitsPerOuting * 5);
  const used   = new Set();
  const routes = [];

  for (let i = 0; i < numOutings; i++) {
    const seed = pool.find(p => !used.has(p.contact_id));
    if (!seed) break;

    const available = pool.filter(p => !used.has(p.contact_id));
    const routeProspects = buildOneRoute(seed, available, visitsPerOuting, maxRadius);
    routeProspects.forEach(p => used.add(p.contact_id));

    const ordered = nearestNeighborOrder(routeProspects);
    const { legs, totalMiles } = calcLegs(ordered);

    routes.push({
      label:      cityLabel(ordered),
      prospects:  ordered,
      legs,
      totalMiles: Math.round(totalMiles * 10) / 10,
      avgIcp:     Math.round(ordered.reduce((s, p) => s + p.icp_score, 0) / Math.max(ordered.length, 1) * 10) / 10,
    });
  }

  return routes.sort((a, b) => b.avgIcp - a.avgIcp);
}

function buildOneRoute(seed, available, maxStops, maxRadius) {
  const route    = [seed];
  const rest     = available.filter(p => p.contact_id !== seed.contact_id);
  let cLat = seed.latitude, cLng = seed.longitude;

  while (route.length < maxStops && rest.length) {
    let bestScore = -1, bestIdx = -1;

    for (let i = 0; i < rest.length; i++) {
      const dist = haversine(cLat, cLng, rest[i].latitude, rest[i].longitude);
      if (dist > maxRadius) continue;
      const score = rest[i].icp_score + 50 * (1 - dist / maxRadius);
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }

    if (bestIdx === -1) break;
    route.push(rest.splice(bestIdx, 1)[0]);
    cLat = route.reduce((s, p) => s + p.latitude, 0) / route.length;
    cLng = route.reduce((s, p) => s + p.longitude, 0) / route.length;
  }

  return route;
}

function nearestNeighborOrder(prospects) {
  const rem     = [...prospects];
  const ordered = [];
  let curLat = BASE_LAT(), curLng = BASE_LNG();

  while (rem.length) {
    let minDist = Infinity, minIdx = 0;
    for (let i = 0; i < rem.length; i++) {
      const d = haversine(curLat, curLng, rem[i].latitude, rem[i].longitude);
      if (d < minDist) { minDist = d; minIdx = i; }
    }
    const next = rem.splice(minIdx, 1)[0];
    ordered.push(next);
    curLat = next.latitude;
    curLng = next.longitude;
  }

  return ordered;
}

function calcLegs(ordered) {
  let totalMiles = 0;
  let prevLat = BASE_LAT(), prevLng = BASE_LNG();
  const legs = ordered.map(p => {
    const miles    = Math.round(haversine(prevLat, prevLng, p.latitude, p.longitude) * 10) / 10;
    const driveMin = Math.max(5, Math.round(miles * 2));
    totalMiles += miles;
    prevLat = p.latitude; prevLng = p.longitude;
    return { miles, driveMin };
  });
  return { legs, totalMiles };
}

function haversine(lat1, lng1, lat2, lng2) {
  const R    = 3959;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a    = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function toRad(deg) { return (deg * Math.PI) / 180; }

function cityLabel(prospects) {
  const counts = {};
  for (const p of prospects) {
    const parts = (p.address || '').split(',');
    if (parts.length >= 2) {
      const city = parts[parts.length - 2].trim().split(' ')[0];
      if (city) counts[city] = (counts[city] || 0) + 1;
    }
  }
  if (!Object.keys(counts).length) return 'East Valley';
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

// ── Visit date helpers ────────────────────────────────────────────────────────

function getNextVisitDates(n, startFrom = null) {
  const VISIT_DAYS = [2, 4]; // Tuesday = 2, Thursday = 4 in JS (0 = Sunday)
  const dates = [];
  const current = startFrom ? new Date(startFrom) : new Date();
  current.setDate(current.getDate() + 1);

  while (dates.length < n) {
    if (VISIT_DAYS.includes(current.getDay())) dates.push(new Date(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

// ── LACRM calendar event creation ────────────────────────────────────────────

async function scheduleRoute(route, visitDate, slot) {
  const slotConfig = VISIT_SLOTS[slot] || VISIT_SLOTS.morning;
  const current    = new Date(visitDate);
  current.setHours(slotConfig.hour, slotConfig.minute, 0, 0);

  for (let idx = 0; idx < route.prospects.length; idx++) {
    const p   = route.prospects[idx];
    const leg = route.legs[idx];

    current.setTime(current.getTime() + leg.driveMin * 60000);
    const end = new Date(current.getTime() + 20 * 60000); // 20-min visit

    const description = buildEventDescription(p, idx, leg);

    await callLacrm('CreateEvent', {
      Name:        `🚐 Drop-In: ${p.name}`,
      Date:        current.toISOString().split('T')[0],
      StartTime:   formatTime(current),
      EndTime:     formatTime(end),
      Description: description.slice(0, 5000),
      ContactId:   p.contact_id || '',
    });

    // Advance pipeline status to "Drop-In Scheduled"
    if (p.pipeline_item_id && process.env.LACRM_DROPIN_SCHEDULED_STATUS_ID) {
      await callLacrm('EditPipelineItem', {
        PipelineItemId: p.pipeline_item_id,
        StatusId:       process.env.LACRM_DROPIN_SCHEDULED_STATUS_ID,
      });
    }

    current.setTime(end.getTime());
    await sleep(300);
  }
}

function buildEventDescription(p, idx, leg) {
  const lines = [
    `📍 DROP-IN VISIT #${idx + 1}`,
    '',
    `Restaurant: ${p.name}`,
    `Address:    ${p.address}`,
    `Phone:      ${p.phone}`,
    `ICP Score:  ${p.icp_score}/100  |  Grease: ${p.grease_score}/5`,
    `Drive from ${idx === 0 ? 'base' : 'last stop'}: ~${leg.driveMin} min (${leg.miles} mi)`,
  ];

  if (p.owner_name && p.owner_name !== 'Not identified') {
    lines.push(`\nAsk for: ${p.owner_name}`);
  }
  if (p.talking_point_1) {
    lines.push('\n--- Talking Points ---');
    lines.push(`1. ${p.talking_point_1}`);
    if (p.talking_point_2) lines.push(`2. ${p.talking_point_2}`);
    if (p.talking_point_3) lines.push(`3. ${p.talking_point_3}`);
  }
  if (p.recommended_approach) {
    lines.push(`\nApproach: ${p.recommended_approach}`);
  }

  return lines.join('\n');
}

function formatTime(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// ── Discovery result persistence (lightweight JSON file) ─────────────────────
// Survives server restarts so you can run /discover, restart the server, then
// run /import — same behavior as having restaurant_prospects.json on disk.

import { writeFile, readFile } from 'fs/promises';

const PROSPECTS_FILE = './restaurant_prospects.json';

async function saveDiscoveryJson(prospects) {
  try {
    await writeFile(PROSPECTS_FILE, JSON.stringify(prospects, null, 2), 'utf8');
    console.log(`[Discover] Saved ${prospects.length} prospects to ${PROSPECTS_FILE}`);
  } catch (err) {
    console.warn('[Discover] Could not save JSON file:', err.message);
  }
}

async function loadDiscoveryJson() {
  try {
    const data = await readFile(PROSPECTS_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export default router;
