import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SELCO_VENDOR_SERVICE_ROLE_KEY || '';
const USER_AGENT = 'Better India Geocode Backfill/1.0';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function requireString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanText(value) {
  return requireString(value).replace(/\s+/g, ' ').trim();
}

function dedupe(values) {
  return [...new Set((values || []).map((value) => cleanText(value)).filter(Boolean))];
}

function toNullableNumber(value) {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function buildGeocodeQueries(row) {
  const rawCandidates = [
    [row.contact_address, row.place_label, row.state, row.country || 'India'].filter(Boolean).join(', '),
    [row.place_label, row.state, row.country || 'India'].filter(Boolean).join(', '),
    [row.state, row.country || 'India'].filter(Boolean).join(', '),
  ];
  const normalized = dedupe(rawCandidates);
  const expanded = [];
  for (const query of normalized) {
    expanded.push(query);
    const parts = query.split(',').map((part) => cleanText(part)).filter(Boolean);
    if (parts.length >= 2) {
      for (let index = 1; index < parts.length; index += 1) {
        expanded.push(parts.slice(index).join(', '));
      }
    }
    const softened = cleanText(query.replace(/\b(valley|district|block|taluk|tehsil|village|forest|reserve|lake|river)\b/gi, ''));
    if (softened && softened !== query) expanded.push(softened);
  }
  return dedupe(expanded);
}

async function geocodeStory(row) {
  const queries = buildGeocodeQueries(row);
  for (const query of queries) {
    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      });
      if (!response.ok) continue;
      const data = await response.json();
      const match = Array.isArray(data) ? data[0] : null;
      const latitude = toNullableNumber(match?.lat);
      const longitude = toNullableNumber(match?.lon);
      if (latitude !== null && longitude !== null && (Math.abs(latitude) > 0.0001 || Math.abs(longitude) > 0.0001)) {
        return { latitude, longitude, geocode_query: query };
      }
    } catch {}
  }
  return null;
}

async function loadNullRows() {
  const { data, error } = await supabase
    .from('better_india_stories')
    .select('story_uid, title, place_label, contact_address, state, country, raw_story')
    .is('latitude', null)
    .order('source_published_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(`Could not load null geocode rows: ${error.message}`);
  return data || [];
}

async function run() {
  const rows = await loadNullRows();
  let updated = 0;
  for (const row of rows) {
    const geocoded = await geocodeStory(row);
    if (!geocoded) continue;
    const rawStory = typeof row.raw_story === 'object' && row.raw_story ? row.raw_story : {};
    const { error } = await supabase
      .from('better_india_stories')
      .update({
        latitude: geocoded.latitude,
        longitude: geocoded.longitude,
        raw_story: { ...rawStory, geocode_query: geocoded.geocode_query },
        updated_at: new Date().toISOString(),
      })
      .eq('story_uid', row.story_uid);
    if (error) throw new Error(`Could not update ${row.story_uid}: ${error.message}`);
    updated += 1;
  }
  console.log(JSON.stringify({ scanned: rows.length, updated }));
}

await run();
