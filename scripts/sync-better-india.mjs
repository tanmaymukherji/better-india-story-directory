import { createClient } from '@supabase/supabase-js';
import { load } from 'cheerio';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SELCO_VENDOR_SERVICE_ROLE_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_MODELS = (process.env.GEMINI_MODELS || 'gemini-2.5-flash-lite,gemini-2.5-flash,gemini-flash-lite-latest,gemini-flash-latest,gemini-2.0-flash-lite,gemini-2.0-flash')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const REQUESTED_BY = process.env.BETTER_INDIA_REQUESTED_BY || process.env.GITHUB_ACTOR || 'scheduled';
const BETTER_INDIA_BASE_URL = 'https://thebetterindia.com';
const BETTER_INDIA_LISTING_URL = `${BETTER_INDIA_BASE_URL}/stories`;
const MAX_STORIES_PER_RUN = 10;
const LATEST_STORY_CHECKS_PER_RUN = 3;
const MAX_COMPILATION_LINKS_PER_STORY = Math.max(2, Number(process.env.MAX_COMPILATION_LINKS_PER_STORY || 4));
const GEMINI_REQUEST_DELAY_MS = Math.max(0, Number(process.env.GEMINI_REQUEST_DELAY_MS || 4000));
const GEMINI_MAX_STORY_CHARS = Math.max(3000, Number(process.env.GEMINI_MAX_STORY_CHARS || 9000));
const STALE_RUN_MINUTES = Math.max(5, Number(process.env.BETTER_INDIA_STALE_RUN_MINUTES || 20));
const SIX_M_OPTIONS = ['Manpower', 'Method', 'Material', 'Machine', 'Money', 'Market'];
const SIX_M_SIGNAL_MAP = {
  Manpower: /\b(training|trainings|trainer|trainers|trainee|trainees|capacity building|skill building|workshop|workshops)\b/i,
  Method: /\b(consulting|consultancy|consultant|mentoring|mentor|technology transfer|process|processes|workflow|protocol|sop|sops|standard operating procedure|manual|manuals|blog|blogs|video|videos|guide|guides)\b/i,
  Material: /\b(raw material|raw materials|material supply|supply of materials|input supply|feedstock)\b/i,
  Machine: /\b(machine|machines|machinery|equipment|plant setup|plant installation|production line|processing unit|tooling)\b/i,
  Money: /\b(financial support|funding support|grant|grants|loan|loans|credit support|working capital|subsidy|subsidies|investment support)\b/i,
  Market: /\b(product purchase|material purchase|procurement|market support|market linkage|market linkages|market report|buyer support|sales channel|distribution support)\b/i,
};
const USER_AGENT = 'Better India Story Directory Sync/2.0';
let availableGeminiModelsPromise = null;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
}
if (!GEMINI_API_KEY) {
  throw new Error('GEMINI_API_KEY or GOOGLE_API_KEY is required.');
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

function normalizeText(value) {
  return cleanText(value).toLowerCase();
}

function dedupe(values) {
  return [...new Set((values || []).map((value) => cleanText(value)).filter(Boolean))];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeModelName(value) {
  const name = requireString(value);
  return name.startsWith('models/') ? name.slice('models/'.length) : name;
}

function slugify(value) {
  return requireString(value)
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '-');
}

function safeUrl(value) {
  if (!value) return '';
  try {
    return new URL(value, BETTER_INDIA_BASE_URL).toString();
  } catch {
    return '';
  }
}

function getPathSegments(url) {
  try {
    return new URL(url).pathname.split('/').map((value) => value.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function looksLikeStorySlug(value) {
  const slug = requireString(value).toLowerCase();
  return /\d{5,}$/.test(slug) || (slug.split('-').length >= 5 && slug.length >= 30);
}

function isStoryUrl(url) {
  try {
    const parsed = new URL(url);
    if (!/thebetterindia\.com$/i.test(parsed.hostname)) return false;
    const segments = getPathSegments(url);
    if (!segments.length) return false;
    if (['stories', 'author', 'web-stories', 'tag', 'category'].includes(segments[0]?.toLowerCase?.())) return false;
    if (segments.length === 1) return looksLikeStorySlug(segments[0]);
    return looksLikeStorySlug(segments[segments.length - 1]);
  } catch {
    return false;
  }
}

function parseDateToIso(value) {
  const text = cleanText(value);
  if (!text) return null;
  const timestamp = Date.parse(text);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function storyUidFromUrl(url) {
  try {
    const pathname = new URL(url).pathname.replace(/\/+$/, '');
    return slugify(pathname.replace(/\//g, ' '));
  } catch {
    return slugify(url);
  }
}

function normalizeLocationValue(value) {
  return requireString(value)
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s*\|\s*/g, ' | ')
    .trim();
}

function dedupeLocations(values) {
  const seen = new Set();
  const output = [];
  for (const value of values || []) {
    const normalized = normalizeLocationValue(value);
    const key = normalized.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function extractEmails(text) {
  return dedupe((text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map((item) => item.toLowerCase()));
}

function normalizePhone(value) {
  const digits = requireString(value).replace(/[^\d]/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `+91 ${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return cleanText(value);
}

function extractPhones(text) {
  return dedupe((text.match(/(?:\+?91[\s-]*)?[6-9]\d{2}[\s-]*\d{3}[\s-]*\d{4}/g) || []).map(normalizePhone));
}

function inferSixMHeuristically(text) {
  const haystack = normalizeText(text);
  if (!haystack) return [];
  const matches = [];
  for (const option of SIX_M_OPTIONS) {
    if (SIX_M_SIGNAL_MAP[option]?.test(haystack)) matches.push(option);
  }
  return matches;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': USER_AGENT,
    },
  });
  if (!response.ok) throw new Error(`Fetch failed for ${url}: ${response.status}`);
  return await response.text();
}

function extractPageCount(html) {
  const $ = load(html);
  const numbers = $('a, span')
    .map((_, el) => Number.parseInt(cleanText($(el).text()), 10))
    .get()
    .filter((value) => Number.isFinite(value) && value > 0);
  return numbers.length ? Math.max(...numbers) : 1;
}

function parseListingPage(html, pageNumber) {
  const $ = load(html);
  const seen = new Set();
  const items = [];
  $('a[href]').each((_, link) => {
    const anchor = $(link);
    const detailUrl = safeUrl(anchor.attr('href') || '');
    if (!isStoryUrl(detailUrl) || seen.has(detailUrl)) return;
    const article = anchor.closest('article, .jeg_post, .jeg_postblock_content, .td_module_wrap, .elementor-post');
    const title = cleanText(anchor.text()) || cleanText(article.find('h1,h2,h3,h4').first().text());
    if (!title || title.length < 12) return;
    const excerpt = cleanText(article.find('p').first().text());
    const thematicArea = cleanText(article.find('a[href*="/stories/"], a[href*="/category/"]').last().text());
    const metaText = cleanText(article.text());
    const publishedAt = parseDateToIso(metaText.match(/\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}\b/)?.[0] || '');
    const authorName = cleanText(metaText.match(/By\s+([A-Za-z .'-]{3,80})/i)?.[1] || '');
    const imageUrl = safeUrl(article.find('img').first().attr('src') || anchor.find('img').first().attr('src') || '');
    seen.add(detailUrl);
    items.push({
      detailUrl,
      title,
      excerpt,
      thematicArea,
      publishedAt,
      authorName: authorName || null,
      imageUrl: imageUrl || null,
      pageNumber,
      pagePosition: items.length + 1,
    });
  });
  return { items, pageCount: extractPageCount(html) };
}

async function scrapeListingPage(pageNumber) {
  const candidates = pageNumber === 1
    ? [BETTER_INDIA_LISTING_URL, `${BETTER_INDIA_LISTING_URL}/`]
    : [`${BETTER_INDIA_LISTING_URL}/page/${pageNumber}/`, `${BETTER_INDIA_LISTING_URL}?paged=${pageNumber}`];
  for (const url of candidates) {
    try {
      const html = await fetchText(url);
      const parsed = parseListingPage(html, pageNumber);
      if (parsed.items.length) return parsed;
    } catch {}
  }
  return { items: [], pageCount: pageNumber };
}

function parseStoryPage(html, listingItem) {
  const $ = load(html);
  const title = cleanText($('h1').first().text()) || listingItem.title;
  const excerpt =
    cleanText($('meta[name="description"]').attr('content') || '') ||
    cleanText($('main p, article p').first().text()) ||
    listingItem.excerpt;
  const authorName =
    cleanText($('[rel="author"]').first().text()) ||
    cleanText($('a[href*="/author/"]').first().text()) ||
    listingItem.authorName ||
    null;
  const thematicArea =
    cleanText($('a[href*="/stories/"], a[href*="/category/"]').first().text()) ||
    listingItem.thematicArea ||
    null;
  const publishedAt =
    parseDateToIso($('meta[property="article:published_time"]').attr('content') || '') ||
    parseDateToIso($('time').first().attr('datetime') || '') ||
    parseDateToIso($('main, article').first().text().match(/\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}\b/)?.[0] || '') ||
    listingItem.publishedAt;
  const coverImageUrl =
    safeUrl($('meta[property="og:image"]').attr('content') || '') ||
    safeUrl($('article img, main img').first().attr('src') || '') ||
    listingItem.imageUrl ||
    null;
  const imageUrls = dedupe($('article img, main img')
    .map((_, el) => safeUrl($(el).attr('src') || ''))
    .get()
    .filter((url) => /^https?:\/\//i.test(url) && !/logo|icon|avatar/i.test(url)));
  const paragraphs = $('article p, main p')
    .map((_, el) => cleanText($(el).text()))
    .get()
    .filter((text) => text && text.length > 30 && !/advertis/i.test(text) && !/follow us/i.test(text));
  const inlineStoryLinks = dedupe($('article a[href], main a[href]')
    .map((_, el) => {
      const anchor = $(el);
      const detailUrl = safeUrl(anchor.attr('href') || '');
      const title = cleanText(anchor.text()) || null;
      if (!isStoryUrl(detailUrl) || detailUrl === listingItem.detailUrl) return null;
      return JSON.stringify({ detailUrl, title });
    })
    .get()
    .filter(Boolean))
    .map((value) => {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return {
    title,
    excerpt,
    authorName,
    thematicArea,
    publishedAt,
    coverImageUrl,
    imageUrls: imageUrls.length ? imageUrls : (coverImageUrl ? [coverImageUrl] : []),
    storyText: dedupe(paragraphs).join('\n\n'),
    inlineStoryLinks,
  };
}

function stripCodeFences(value) {
  return requireString(value).replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
}

function parseJsonObject(text) {
  const cleaned = stripCodeFences(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Gemini response did not include valid JSON.');
    return JSON.parse(match[0]);
  }
}

function normalizeSixM(values) {
  const list = Array.isArray(values) ? values.map((item) => cleanText(String(item || ''))) : [];
  const matched = list
    .map((item) => SIX_M_OPTIONS.find((option) => option.toLowerCase() === item.toLowerCase()))
    .filter(Boolean);
  return dedupe(matched);
}

function normalizeTags(values) {
  const list = Array.isArray(values) ? values.map((item) => cleanText(String(item || ''))) : [];
  return dedupe(list).slice(0, 16);
}

function normalizeContributors(values) {
  const list = Array.isArray(values) ? values : [];
  const seen = new Set();
  const output = [];
  for (const value of list) {
    const name = cleanText(value?.name);
    const contribution = cleanText(value?.contribution);
    if (!name && !contribution) continue;
    const key = `${name.toLowerCase()}|${contribution.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({
      name: name || null,
      contribution: contribution || null,
    });
  }
  return output.slice(0, 12);
}

function normalizeProcessSteps(values) {
  const list = Array.isArray(values) ? values.map((item) => cleanText(String(item || ''))) : [];
  return dedupe(list).slice(0, 12);
}

function buildDisplaySummary(summary, contributors = [], processSteps = []) {
  const sections = [];
  const cleanSummary = cleanText(summary);
  if (cleanSummary) sections.push(cleanSummary);
  if (contributors.length) {
    sections.push(`People and actions: ${contributors.map((item) => {
      const name = cleanText(item?.name) || 'Contributor';
      const contribution = cleanText(item?.contribution) || 'No specific contribution noted.';
      return `${name}: ${contribution}`;
    }).join(' ')}`);
  }
  if (processSteps.length) {
    sections.push(`Process steps: ${processSteps.map((step, index) => `${index + 1}. ${step}`).join(' ')}`);
  }
  return sections.join('\n\n').trim() || null;
}

function buildInvolvedPeopleName(primaryName, contributors = []) {
  const contributorNames = dedupe(contributors.map((item) => item?.name));
  const names = contributorNames.length
    ? contributorNames
    : dedupe([primaryName]);
  return names.length ? names.join(', ') : 'Unknown Person';
}

function shouldExpandCompilationStory(listingItem, parsedStory) {
  const signals = normalizeText([listingItem.title, listingItem.excerpt, parsedStory.excerpt].join(' '));
  const hasTitleSignal = /\b(top|best|must[- ]read|list|roundup|round-up|stories|story collection|here are|these|from\b.+\bto\b)\b/i.test(signals);
  return parsedStory.inlineStoryLinks.length >= 4 || (parsedStory.inlineStoryLinks.length >= 2 && hasTitleSignal);
}

function buildCompilationChildren(listingItem, parsedStory) {
  return (parsedStory.inlineStoryLinks || [])
    .slice(0, MAX_COMPILATION_LINKS_PER_STORY)
    .map((child, index) => ({
      detailUrl: child.detailUrl,
      title: child.title || `Referenced story ${index + 1}`,
      excerpt: parsedStory.excerpt || listingItem.excerpt,
      thematicArea: listingItem.thematicArea || parsedStory.thematicArea,
      publishedAt: parsedStory.publishedAt || listingItem.publishedAt,
      authorName: parsedStory.authorName || listingItem.authorName || null,
      imageUrl: parsedStory.coverImageUrl || listingItem.imageUrl || null,
      pageNumber: listingItem.pageNumber,
      pagePosition: listingItem.pagePosition,
      parentStoryUrl: listingItem.detailUrl,
      parentStoryTitle: parsedStory.title || listingItem.title,
    }));
}

async function summarizeWithGemini(listingItem, parsedStory) {
  const prompt = [
    'Extract a structured summary from this Better India story.',
    'Return strict JSON only.',
    'Schema:',
    '{"person_name":string|null,"contributors":[{"name":string|null,"contribution":string|null}],"contact_address":string|null,"contact_email":string|null,"contact_phone":string|null,"place":string|null,"thematic_area":string|null,"summary_of_work":string|null,"process_steps":string[],"six_m_categories":string[],"tags":string[]}',
    'Rules:',
    '- Use null when the article does not provide a reliable value.',
    '- six_m_categories must only use: Manpower, Method, Material, Machine, Money, Market.',
    '- Apply 6M strictly using these meanings:',
    '- Manpower = trainings or capacity-building support.',
    '- Method = consulting, mentoring, technology transfer, processes, videos, SOPs, manuals, or blogs.',
    '- Market = product/material purchase, market support, or market reports.',
    '- Material = raw material supply.',
    '- Machine = machinery or plant setup.',
    '- Money = financial support.',
    '- Do not assign a 6M category unless the story clearly supports that exact meaning.',
    '- tags should be short descriptive keywords.',
    '- person_name should be the main changemaker, founder, farmer, entrepreneur, or organisation representative the story centres on.',
    '- If multiple people or experts are quoted, contributors must capture each person and their specific advice, action, or role.',
    '- place should be the main operational place mentioned in the story.',
    '- summary_of_work must be useful and specific, not generic. Mention concrete actions, outcomes, and person-wise advice where relevant.',
    '- If the article describes a how-to, routine, method, or action plan, process_steps must contain clear ordered steps.',
    '- If the article contains multiple tips, recommendations, or expert viewpoints, summarize them distinctly instead of collapsing them into one generic paragraph.',
    `Title: ${listingItem.title}`,
    `Listing excerpt: ${listingItem.excerpt}`,
    `Thematic area from listing: ${listingItem.thematicArea || 'Unknown'}`,
    `Author: ${parsedStory.authorName || 'Unknown'}`,
    `Published at: ${parsedStory.publishedAt || 'Unknown'}`,
    `Story body:\n${parsedStory.storyText.slice(0, GEMINI_MAX_STORY_CHARS)}`,
  ].join('\n');

  const candidateModels = await getUsableGeminiModels();
  let lastError = null;
  for (let modelIndex = 0; modelIndex < candidateModels.length; modelIndex += 1) {
    const modelName = candidateModels[modelIndex];
    if (modelIndex > 0) await sleep(1500);
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      }),
    });
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      const isQuotaError = response.status === 429 || /quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(raw);
      const quotaMessage = `Gemini quota unavailable for ${modelName}. ${raw || `Request failed with status ${response.status}.`}`;
      if (isQuotaError) {
        lastError = new Error(quotaMessage);
        continue;
      }
      throw new Error(raw || `Gemini request failed (${response.status})`);
    }
    const data = await response.json();
    const text = String(data?.candidates?.[0]?.content?.parts?.[0]?.text || '');
    const parsed = parseJsonObject(text);
    return {
      aiModel: modelName,
      summary: {
        person_name: cleanText(parsed.person_name) || null,
        contributors: normalizeContributors(parsed.contributors),
        contact_address: cleanText(parsed.contact_address) || null,
        contact_email: cleanText(parsed.contact_email) || null,
        contact_phone: cleanText(parsed.contact_phone) || null,
        place: cleanText(parsed.place) || null,
        thematic_area: cleanText(parsed.thematic_area) || null,
        summary_of_work: cleanText(parsed.summary_of_work) || null,
        process_steps: normalizeProcessSteps(parsed.process_steps),
        six_m_categories: normalizeSixM(parsed.six_m_categories),
        tags: normalizeTags(parsed.tags),
      },
    };
  }

  throw lastError || new Error('Gemini summary generation failed for all configured models.');
}

async function fetchAvailableGeminiModels() {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    throw new Error(raw || `Gemini models list failed (${response.status})`);
  }
  const data = await response.json();
  return (Array.isArray(data?.models) ? data.models : [])
    .filter((model) => Array.isArray(model?.supportedGenerationMethods) && model.supportedGenerationMethods.includes('generateContent'))
    .map((model) => normalizeModelName(model?.name))
    .filter(Boolean);
}

async function getUsableGeminiModels() {
  if (!availableGeminiModelsPromise) {
    availableGeminiModelsPromise = fetchAvailableGeminiModels().catch((error) => {
      availableGeminiModelsPromise = null;
      throw error;
    });
  }
  const availableModels = await availableGeminiModelsPromise;
  const availableSet = new Set(availableModels);
  const preferredModels = GEMINI_MODELS.map(normalizeModelName).filter((name) => availableSet.has(name));
  if (preferredModels.length) return preferredModels;

  const sensibleFallbacks = availableModels.filter((name) => /^gemini-.*(?:flash|pro)/i.test(name));
  if (sensibleFallbacks.length) return sensibleFallbacks;

  if (availableModels.length) return availableModels;
  throw new Error('No Gemini models with generateContent support were returned for this API key.');
}

function buildSearchText(row) {
  return [
    requireString(row.title),
    requireString(row.person_name),
    requireString(row.thematic_area),
    requireString(row.place_label),
    requireString(row.location_text),
    requireString(row.summary_of_work),
    requireString(row.story_excerpt),
    requireString(row.contact_email),
    requireString(row.contact_phone),
    requireString(row.contact_address),
    (row.ai_summary?.contributors || []).map((item) => [item?.name, item?.contribution].filter(Boolean).join(' ')).join(' '),
    (row.ai_summary?.process_steps || []).join(' '),
    (row.tags || []).join(' '),
    (row.six_m_categories || []).join(' '),
  ].filter(Boolean).join(' ');
}

function buildPersonSlug(name) {
  return slugify(name || 'unknown-person');
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

async function geocodeStoryFallback(row) {
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
        return { latitude, longitude };
      }
    } catch {}
  }
  return { latitude: null, longitude: null };
}

async function fetchAllRows(table, columns = '*', orderColumn = null) {
  const rows = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let query = supabase.from(table).select(columns).range(from, from + pageSize - 1);
    if (orderColumn) query = query.order(orderColumn);
    const { data, error } = await query;
    if (error) throw new Error(`${table} load failed: ${error.message}`);
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function getSyncState() {
  const { data, error } = await supabase.from('better_india_sync_state').select('*').eq('state_key', 'default').maybeSingle();
  if (error) throw new Error(`Could not load Better India sync state: ${error.message}`);
  if (data) return data;
  const { data: inserted, error: insertError } = await supabase
    .from('better_india_sync_state')
    .insert({ state_key: 'default', last_total: 0, backfill_next_page: null })
    .select('*')
    .single();
  if (insertError || !inserted) throw new Error(`Could not initialize Better India sync state: ${insertError?.message || 'unknown error'}`);
  return inserted;
}

async function updateSyncState(values) {
  const { error } = await supabase
    .from('better_india_sync_state')
    .upsert({ state_key: 'default', updated_at: new Date().toISOString(), ...values }, { onConflict: 'state_key' });
  if (error) throw new Error(`Could not update Better India sync state: ${error.message}`);
}

async function markStaleRunningSyncs() {
  const staleBefore = new Date(Date.now() - STALE_RUN_MINUTES * 60 * 1000).toISOString();
  const { error } = await supabase
    .from('better_india_sync_runs')
    .update({
      status: 'failed',
      finished_at: new Date().toISOString(),
      error_message: 'Marked failed because a newer sync started after this run stalled.',
      updated_at: new Date().toISOString(),
    })
    .eq('status', 'running')
    .lt('started_at', staleBefore);
  if (error) throw new Error(`Could not update stale Better India sync runs: ${error.message}`);
}

async function loadExistingStoryIds() {
  const rows = await fetchAllRows('better_india_stories', 'story_uid');
  return new Set(rows.map((row) => row.story_uid));
}

async function purgeInvalidStoredStories() {
  const rows = await fetchAllRows('better_india_stories', 'story_uid, story_url');
  const invalidIds = rows
    .filter((row) => !isStoryUrl(row.story_url))
    .map((row) => row.story_uid)
    .filter(Boolean);
  for (let index = 0; index < invalidIds.length; index += 50) {
    const batch = invalidIds.slice(index, index + 50);
    if (!batch.length) continue;
    const { error } = await supabase.from('better_india_stories').delete().in('story_uid', batch);
    if (error) throw new Error(`Could not remove invalid Better India records: ${error.message}`);
  }
  return invalidIds.length;
}

async function chooseStoriesForRun(syncState, existingStoryIds) {
  const firstPage = await scrapeListingPage(1);
  const pageCount = Math.max(1, firstPage.pageCount);
  const latestUnknown = firstPage.items
    .filter((item) => !existingStoryIds.has(storyUidFromUrl(item.detailUrl)))
    .slice(0, LATEST_STORY_CHECKS_PER_RUN);

  let backfillPage = Number(syncState.backfill_next_page || pageCount || 1);
  if (!Number.isFinite(backfillPage) || backfillPage < 1) backfillPage = pageCount || 1;
  const backlogItems = [];
  let scannedPages = 0;

  while (backlogItems.length < MAX_STORIES_PER_RUN && backfillPage >= 1 && scannedPages < 4) {
    const pageResult = backfillPage === 1 ? firstPage : await scrapeListingPage(backfillPage);
    const pageUnknown = [...pageResult.items]
      .reverse()
      .filter((item) => !existingStoryIds.has(storyUidFromUrl(item.detailUrl)));
    backlogItems.push(...pageUnknown);
    backfillPage -= 1;
    scannedPages += 1;
    if (!pageUnknown.length && backfillPage < 1) break;
  }

  const selected = [];
  const seen = new Set();
  for (const item of [...latestUnknown, ...backlogItems]) {
    if (seen.has(item.detailUrl)) continue;
    seen.add(item.detailUrl);
    selected.push(item);
    if (selected.length >= MAX_STORIES_PER_RUN) break;
  }

  return {
    selected,
    pageCount,
    latestUrl: firstPage.items[0]?.detailUrl || syncState.last_seen_latest_story_url || null,
    nextBackfillPage: backfillPage < 1 ? pageCount : backfillPage,
  };
}

function buildStoryRow(listingItem, parsedStory, aiSummary, aiModel) {
  const heuristicsEmails = extractEmails(parsedStory.storyText);
  const heuristicsPhones = extractPhones(parsedStory.storyText);
  const title = parsedStory.title || listingItem.title;
  const basePersonName = aiSummary.person_name || title.match(/^([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3})/)?.[1] || null;
  const personName = buildInvolvedPeopleName(basePersonName, aiSummary.contributors || []);
  const place = aiSummary.place || parsedStory.storyText.match(/\b(?:in|from|at)\s+([A-Z][A-Za-z .'-]+(?:,\s*[A-Z][A-Za-z .'-]+){0,2})/)?.[1] || null;
  const richSummary = buildDisplaySummary(
    aiSummary.summary_of_work || parsedStory.excerpt || listingItem.excerpt || null,
    aiSummary.contributors || [],
    aiSummary.process_steps || [],
  );
  const inferredSixM = normalizeSixM([
    ...(aiSummary.six_m_categories || []),
    ...inferSixMHeuristically([
      title,
      parsedStory.excerpt,
      parsedStory.storyText,
      aiSummary.summary_of_work,
      ...(aiSummary.process_steps || []),
      ...(aiSummary.contributors || []).map((item) => `${item?.name || ''} ${item?.contribution || ''}`),
      ...(aiSummary.tags || []),
    ].join(' ')),
  ]);
  const row = {
    story_uid: storyUidFromUrl(listingItem.detailUrl),
    story_url: listingItem.detailUrl,
    title,
    person_name: personName,
    person_slug: buildPersonSlug(personName),
    author_name: parsedStory.authorName || listingItem.authorName || null,
    thematic_area: aiSummary.thematic_area || parsedStory.thematicArea || listingItem.thematicArea || null,
    place_label: place,
    location_text: dedupeLocations([aiSummary.contact_address, place]).join(' | ') || null,
    state: place,
    country: 'India',
    contact_email: aiSummary.contact_email || heuristicsEmails[0] || null,
    contact_phone: aiSummary.contact_phone || heuristicsPhones[0] || null,
    contact_address: aiSummary.contact_address || place,
    summary_of_work: richSummary,
    story_excerpt: parsedStory.excerpt || listingItem.excerpt || null,
    six_m_categories: inferredSixM,
    tags: dedupe([...(aiSummary.tags || []), ...(parsedStory.thematicArea ? [parsedStory.thematicArea] : [])]),
    cover_image_url: parsedStory.coverImageUrl || listingItem.imageUrl || null,
    story_image_urls: parsedStory.imageUrls,
    latitude: null,
    longitude: null,
    source_published_at: parsedStory.publishedAt || listingItem.publishedAt || null,
    source_listing_page: listingItem.pageNumber,
    source_listing_position: listingItem.pagePosition,
    source_status: listingItem.parentStoryUrl ? 'compilation_child' : 'synced',
    admin_notes: null,
    ai_model: aiModel,
    ai_summary: aiSummary,
    raw_story: {
      listing: listingItem,
      parsed_excerpt: parsedStory.excerpt,
      parsed_author: parsedStory.authorName,
      parent_story_url: listingItem.parentStoryUrl || null,
      parent_story_title: listingItem.parentStoryTitle || null,
      inline_story_links: parsedStory.inlineStoryLinks || [],
    },
    synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  row.search_text = buildSearchText(row);
  return row;
}

async function runSync() {
  await markStaleRunningSyncs();
  const purgedInvalidCount = await purgeInvalidStoredStories();
  const syncState = await getSyncState();
  const { data: runData, error: runError } = await supabase
    .from('better_india_sync_runs')
    .insert({ status: 'running', requested_by: REQUESTED_BY, started_at: new Date().toISOString() })
    .select('id')
    .single();
  if (runError || !runData?.id) throw new Error('Better India sync run could not be created.');
  const runId = runData.id;

  try {
    const existingStoryIds = await loadExistingStoryIds();
    const selection = await chooseStoriesForRun(syncState, existingStoryIds);
    await updateSyncState({
      last_started_at: new Date().toISOString(),
      last_total: selection.pageCount,
      last_seen_latest_story_url: selection.latestUrl,
      backfill_next_page: selection.nextBackfillPage,
    });

    if (!selection.selected.length) {
      await supabase.from('better_india_sync_runs').update({
        status: 'success',
        finished_at: new Date().toISOString(),
        story_count: 0,
        error_message: 'No new Better India stories were found in this run.',
        updated_at: new Date().toISOString(),
      }).eq('id', runId);
      await updateSyncState({ last_finished_at: new Date().toISOString() });
      return;
    }

    let processedCount = 0;
    const queue = [...selection.selected];
    const queuedUrls = new Set(queue.map((item) => item.detailUrl));
    const seenStoryIds = new Set();

    while (queue.length && processedCount < MAX_STORIES_PER_RUN) {
      const listingItem = queue.shift();
      if (!listingItem?.detailUrl) continue;
      queuedUrls.delete(listingItem.detailUrl);
      const storyUid = storyUidFromUrl(listingItem.detailUrl);
      if (existingStoryIds.has(storyUid) || seenStoryIds.has(storyUid) || !isStoryUrl(listingItem.detailUrl)) continue;

      const html = await fetchText(listingItem.detailUrl);
      const parsedStory = parseStoryPage(html, listingItem);
      if (shouldExpandCompilationStory(listingItem, parsedStory)) {
        const children = buildCompilationChildren(listingItem, parsedStory)
          .filter((child) => {
            const childUid = storyUidFromUrl(child.detailUrl);
            return !existingStoryIds.has(childUid) && !seenStoryIds.has(childUid) && !queuedUrls.has(child.detailUrl);
          });
        if (children.length) {
          [...children].reverse().forEach((child) => {
            queue.unshift(child);
            queuedUrls.add(child.detailUrl);
          });
          continue;
        }
      }

      const { aiModel, summary: aiSummary } = await summarizeWithGemini(listingItem, parsedStory);
      const row = buildStoryRow(listingItem, parsedStory, aiSummary, aiModel);
      const geocoded = await geocodeStoryFallback(row);
      row.latitude = geocoded.latitude;
      row.longitude = geocoded.longitude;
      row.search_text = buildSearchText(row);
      const { error: upsertError } = await supabase.from('better_india_stories').upsert([row], { onConflict: 'story_uid' });
      if (upsertError) throw new Error(`Better India story insert failed: ${upsertError.message}`);
      processedCount += 1;
      seenStoryIds.add(row.story_uid);
      existingStoryIds.add(row.story_uid);
      await supabase.from('better_india_sync_runs').update({
        story_count: processedCount,
        error_message: purgedInvalidCount ? `Removed ${purgedInvalidCount} invalid non-story rows before syncing.` : null,
        updated_at: new Date().toISOString(),
      }).eq('id', runId);
      if (queue.length && processedCount < MAX_STORIES_PER_RUN && GEMINI_REQUEST_DELAY_MS > 0) {
        await sleep(GEMINI_REQUEST_DELAY_MS);
      }
    }

    await supabase.from('better_india_sync_runs').update({
      status: 'success',
      finished_at: new Date().toISOString(),
      story_count: processedCount,
      error_message: purgedInvalidCount ? `Removed ${purgedInvalidCount} invalid non-story rows before syncing.` : null,
      updated_at: new Date().toISOString(),
    }).eq('id', runId);

    await updateSyncState({
      last_finished_at: new Date().toISOString(),
      last_total: selection.pageCount,
      last_seen_latest_story_url: selection.latestUrl,
      backfill_next_page: selection.nextBackfillPage,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Better India story sync failed.';
    await supabase.from('better_india_sync_runs').update({
      status: 'failed',
      finished_at: new Date().toISOString(),
      error_message: message,
      updated_at: new Date().toISOString(),
    }).eq('id', runId);
    await updateSyncState({ last_finished_at: new Date().toISOString() }).catch(() => null);
    throw error;
  }
}

await runSync();
