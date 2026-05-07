/**
 * Google Places Service
 * =======================
 * Mirrors the search, filtering, scoring, and deduplication logic
 * from discover_restaurants_v2.py.
 */

const PLACES_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';

// ── Cuisine / grease scoring (mirrors GREASE_SCORES dict) ────────────────────

const GREASE_SCORES = {
  bbq: 5, barbecue: 5, smokehouse: 5,
  'fried chicken': 5, wings: 5,
  mexican: 4, taqueria: 4, 'tex-mex': 4,
  chinese: 4, wok: 4,
  italian: 4, pizza: 4, pasta: 4,
  indian: 4, curry: 4,
  thai: 4, vietnamese: 4, korean: 4,
  seafood: 4, ramen: 4,
  burger: 4, hamburger: 4,
  japanese: 3, fish: 3, diner: 3,
  mediterranean: 3, greek: 3, grill: 3, american: 3,
  cafe: 2, bakery: 2, vegetarian: 2, vegan: 2, sushi: 2,
  bar: 2, brewery: 2, pub: 3, coffee: 1,
};

const FOOD_TYPES = new Set([
  'restaurant', 'food', 'meal_delivery', 'meal_takeaway', 'cafe', 'bar', 'bakery',
  'american_restaurant', 'barbecue_restaurant', 'breakfast_restaurant',
  'brunch_restaurant', 'chinese_restaurant', 'coffee_shop', 'fast_food_restaurant',
  'french_restaurant', 'greek_restaurant', 'hamburger_restaurant', 'indian_restaurant',
  'italian_restaurant', 'japanese_restaurant', 'korean_restaurant',
  'mediterranean_restaurant', 'mexican_restaurant', 'pizza_restaurant',
  'ramen_restaurant', 'sandwich_shop', 'seafood_restaurant', 'steak_house',
  'sushi_restaurant', 'thai_restaurant', 'vegan_restaurant', 'vegetarian_restaurant',
  'vietnamese_restaurant',
]);

const EXCLUDE_TYPES = new Set([
  'hardware_store', 'home_goods_store', 'car_dealer', 'car_repair', 'gas_station',
  'hospital', 'doctor', 'dentist', 'pharmacy', 'bank', 'atm', 'real_estate_agency',
  'lawyer', 'laundry', 'gym', 'spa', 'school', 'university', 'clothing_store',
  'electronics_store', 'pet_store', 'plumber', 'electrician', 'general_contractor',
]);

const FOOD_KEYWORDS = [
  'restaurant', 'food', 'cafe', 'bakery', 'bar', 'grill', 'pizza', 'taco',
  'burger', 'sushi', 'diner', 'bistro', 'kitchen', 'eatery', 'dining', 'catering', 'deli',
];

// ── Main search (mirrors search_with_pagination()) ───────────────────────────

/**
 * Search Google Places Text Search API with automatic pagination.
 * Returns an array of parsed prospect objects.
 *
 * @param {string} query       e.g. "Mexican restaurant"
 * @param {string} location    e.g. "Chandler, AZ" or zip code "85224"
 * @param {number} maxPages    1–3 (Google allows up to 3 pages of 20)
 */
export async function searchRestaurants(query, location, maxPages = 3) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY is not set');

  const prospects = [];
  let pageToken   = null;

  for (let page = 0; page < maxPages; page++) {
    const body = {
      textQuery:    `${query} in ${location}`,
      languageCode: 'en',
      pageSize:     20,
      ...(pageToken ? { pageToken } : {}),
    };

    const res = await fetch(PLACES_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': [
          'places.id', 'places.displayName', 'places.formattedAddress',
          'places.nationalPhoneNumber', 'places.websiteUri', 'places.rating',
          'places.userRatingCount', 'places.types', 'places.googleMapsUri',
          'places.primaryType', 'places.primaryTypeDisplayName',
          'places.location', 'places.businessStatus', 'nextPageToken',
        ].join(','),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error(`[Places] Error ${res.status} on "${query} in ${location}":`, err?.error?.message);
      break;
    }

    const data  = await res.json();
    pageToken   = data.nextPageToken || null;

    for (const place of data.places || []) {
      if (isFoodBusiness(place)) {
        prospects.push(parsePlace(place, location));
      }
    }

    if (!pageToken) break;
    await sleep(2000); // Google requires a pause before next page token
  }

  return prospects;
}

// ── Food business filter (mirrors is_food_business()) ────────────────────────

function isFoodBusiness(place) {
  const types   = new Set(place.types || []);
  const primary = place.primaryType || '';
  const display = (place.primaryTypeDisplayName?.text || '').toLowerCase();
  const pLower  = primary.toLowerCase();

  if (EXCLUDE_TYPES.has(primary)) return false;
  const hasExclude = [...types].some(t => EXCLUDE_TYPES.has(t));
  const hasFood    = [...types].some(t => FOOD_TYPES.has(t));
  if (hasExclude && !hasFood) return false;
  if (hasFood) return true;
  if (FOOD_KEYWORDS.some(kw => pLower.includes(kw) || display.includes(kw))) return true;
  return false;
}

// ── Place parser (mirrors parse_place()) ─────────────────────────────────────

function parsePlace(place, searchLocation) {
  const name        = place.displayName?.text || 'Unknown';
  const types       = place.types || [];
  const primaryType = place.primaryTypeDisplayName?.text || '';
  const cuisine     = determineCuisine(name, types, primaryType);
  const greaseScore = estimateGreaseScore(cuisine);
  const rating      = place.rating || 0;
  const reviewCount = place.userRatingCount || 0;
  const hasWebsite  = !!place.websiteUri;

  return {
    place_id:        place.id || '',
    name,
    address:         place.formattedAddress || '',
    search_location: searchLocation,
    phone:           place.nationalPhoneNumber || '',
    website:         place.websiteUri || '',
    google_maps_url: place.googleMapsUri || '',
    rating,
    review_count:    reviewCount,
    cuisine_type:    cuisine,
    primary_type:    primaryType,
    grease_score:    greaseScore,
    icp_score:       calcIcpScore(greaseScore, rating, reviewCount, hasWebsite),
    business_status: place.businessStatus || '',
    latitude:        place.location?.latitude  || 0,
    longitude:       place.location?.longitude || 0,
    discovered_date: today(),
    source:          'Google Places API',
  };
}

// ── Scoring helpers (mirrors calculate_icp_score / estimate_grease_score) ────

function determineCuisine(name, types, primaryType) {
  const text = `${name} ${types.join(' ')} ${primaryType}`.toLowerCase();

  const map = {
    BBQ:           ['bbq', 'barbecue', 'smokehouse', 'smoked'],
    Mexican:       ['mexican', 'taqueria', 'taco', 'burrito', 'cantina'],
    Chinese:       ['chinese', 'szechuan', 'dim sum', 'wok', 'noodle'],
    Thai:          ['thai'],
    Vietnamese:    ['vietnamese', 'pho', 'banh mi'],
    Indian:        ['indian', 'curry', 'tandoori', 'masala'],
    Italian:       ['italian', 'pizza', 'pasta', 'trattoria'],
    Japanese:      ['japanese', 'sushi', 'ramen', 'teriyaki'],
    Korean:        ['korean', 'bibimbap', 'bulgogi'],
    Seafood:       ['seafood', 'fish', 'crab', 'lobster', 'oyster'],
    American:      ['american', 'diner', 'grill', 'steakhouse'],
    Mediterranean: ['mediterranean', 'greek', 'falafel', 'kebab', 'shawarma'],
    Burger:        ['burger', 'hamburger'],
    'Fast Casual': ['fast food', 'drive-through', 'quick service'],
    Cafe:          ['cafe', 'coffee', 'bakery', 'tea'],
  };

  for (const [cuisine, keywords] of Object.entries(map)) {
    if (keywords.some(kw => text.includes(kw))) return cuisine;
  }
  return 'Other';
}

function estimateGreaseScore(cuisine) {
  const lower = cuisine.toLowerCase();
  for (const [kw, score] of Object.entries(GREASE_SCORES)) {
    if (lower.includes(kw)) return score;
  }
  return 3;
}

function calcIcpScore(greaseScore, rating, reviewCount, hasWebsite) {
  const greasePts  = (greaseScore / 5) * 40;
  const reviewPts  = Math.min(reviewCount / 500, 1.0) * 30;
  const ratingPts  = rating > 0 ? (rating / 5) * 20 : 10;
  const websiteBonus = hasWebsite ? 10 : 0;
  return Math.round(Math.min(greasePts + reviewPts + ratingPts + websiteBonus, 100) * 10) / 10;
}

// ── Deduplication (mirrors deduplicate_names()) ───────────────────────────────

/**
 * Deduplicate by place_id, filter closed businesses, differentiate
 * same-name restaurants by appending their street address, and sort
 * by ICP score descending.
 */
export function deduplicateProspects(allProspects) {
  // Unique by place_id
  const byId = new Map();
  for (const p of allProspects) {
    if (p.place_id && !byId.has(p.place_id)) byId.set(p.place_id, p);
  }

  const unique = [...byId.values()].filter(p => p.business_status !== 'CLOSED_PERMANENTLY');

  // Differentiate same-name restaurants (LACRM requires unique company names)
  const nameCounts = {};
  for (const p of unique) nameCounts[p.name] = (nameCounts[p.name] || 0) + 1;

  for (const p of unique) {
    if (nameCounts[p.name] > 1) {
      const street = (p.address || '').split(',')[0].trim();
      p.name = street ? `${p.name} (${street})` : p.name;
    }
  }

  return unique.sort((a, b) => b.icp_score - a.icp_score);
}

// ── helpers ───────────────────────────────────────────────────────────────────

function today() { return new Date().toISOString().split('T')[0]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
