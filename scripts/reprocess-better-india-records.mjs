import { load } from 'cheerio';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SELCO_VENDOR_SERVICE_ROLE_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_MODELS = (process.env.GEMINI_MODELS || 'gemini-2.5-flash-lite,gemini-2.5-flash,gemini-flash-lite-latest,gemini-flash-latest,gemini-2.0-flash-lite,gemini-2.0-flash')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const USER_AGENT = 'Better India Summary Reprocess/1.0';
const REPROCESS_LIMIT = Math.max(1, Number(process.env.BETTER_INDIA_REPROCESS_LIMIT || 1000));
const ONLY_STORY_UID = (process.env.BETTER_INDIA_ONLY_STORY_UID || '').trim();
let availableGeminiModelsPromise = null;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !GEMINI_API_KEY) {
  throw new Error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and GEMINI_API_KEY are required.');
}

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

function safeUrl(value) {
  if (!value) return '';
  try {
    return new URL(value).toString();
  } catch {
    return '';
  }
}

function normalizeSixM(values) {
  const options = ['Manpower', 'Method', 'Material', 'Machine', 'Money', 'Market'];
  const list = Array.isArray(values) ? values.map((item) => cleanText(String(item || ''))) : [];
  return dedupe(list
    .map((item) => options.find((option) => option.toLowerCase() === item.toLowerCase()))
    .filter(Boolean));
}

function normalizeTags(values) {
  return dedupe(Array.isArray(values) ? values.map((item) => cleanText(String(item || ''))) : []).slice(0, 16);
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
    output.push({ name: name || null, contribution: contribution || null });
  }
  return output.slice(0, 12);
}

function normalizeProcessSteps(values) {
  return dedupe(Array.isArray(values) ? values.map((item) => cleanText(String(item || ''))) : []).slice(0, 12);
}

function buildDisplaySummary(summary, contributors = [], processSteps = []) {
  const sections = [];
  const cleanSummary = cleanText(summary);
  if (cleanSummary) sections.push(cleanSummary);
  if (contributors.length) {
    sections.push(`People and actions: ${contributors.map((item) => `${cleanText(item?.name) || 'Contributor'}: ${cleanText(item?.contribution) || 'No specific contribution noted.'}`).join(' ')}`);
  }
  if (processSteps.length) {
    sections.push(`Process steps: ${processSteps.map((step, index) => `${index + 1}. ${step}`).join(' ')}`);
  }
  return sections.join('\n\n').trim() || null;
}

function buildInvolvedPeopleName(primaryName, contributors = []) {
  const names = dedupe([
    primaryName,
    ...contributors.map((item) => item?.name),
  ]);
  if (!names.length) return 'Unknown Person';
  if (names.length === 1) return names[0];
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} + ${names.length - 3} more`;
}

function inferSixMHeuristically(text) {
  const haystack = normalizeText(text);
  if (!haystack) return [];
  const signalMap = {
    Manpower: /\b(volunteer|community|workers?|women|self-help group|students?|youth|farmers?|artisans?|team|collective|members?|experts?)\b/i,
    Method: /\b(training|model|process|practice|approach|campaign|awareness|education|technique|system|intervention|recycling|conservation|tip|routine|habit)\b/i,
    Material: /\b(waste|plastic|bamboo|coir|fabric|compost|seed|soil|biodegradable|material|raw material|produce)\b/i,
    Machine: /\b(machine|device|tool|equipment|app|technology|platform|drone|solar|mechanical|digital|ai)\b/i,
    Money: /\b(income|livelihood|funding|loan|saving|finance|revenue|earnings|salary|profit|cost|investment|save money)\b/i,
    Market: /\b(customers?|buyers?|market|sales|selling|brand|distribution|supply chain|enterprise|startup|business|export|consumption)\b/i,
  };
  return Object.entries(signalMap).filter(([, regex]) => regex.test(haystack)).map(([key]) => key);
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    throw new Error(raw || `Supabase request failed (${response.status})`);
  }
  return options.method === 'PATCH' || options.method === 'POST' || options.method === 'DELETE'
    ? await response.text().catch(() => '')
    : await response.json();
}

async function loadRows() {
  const query = ONLY_STORY_UID
    ? `/rest/v1/better_india_stories?select=story_uid,title,story_url,person_name,story_excerpt,thematic_area,author_name,source_published_at,source_listing_page,source_listing_position,cover_image_url,place_label,contact_address,state,country,tags,six_m_categories,ai_summary,raw_story&story_uid=eq.${encodeURIComponent(ONLY_STORY_UID)}`
    : `/rest/v1/better_india_stories?select=story_uid,title,story_url,person_name,story_excerpt,thematic_area,author_name,source_published_at,source_listing_page,source_listing_position,cover_image_url,place_label,contact_address,state,country,tags,six_m_categories,ai_summary,raw_story&order=source_published_at.desc.nullslast&limit=${REPROCESS_LIMIT}`;
  return await fetchJson(query);
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

function parseStoryPage(html, row) {
  const $ = load(html);
  const paragraphs = $('article p, main p')
    .map((_, el) => cleanText($(el).text()))
    .get()
    .filter((text) => text && text.length > 30 && !/advertis/i.test(text) && !/follow us/i.test(text));
  return {
    title: cleanText($('h1').first().text()) || row.title,
    excerpt:
      cleanText($('meta[name="description"]').attr('content') || '') ||
      cleanText($('main p, article p').first().text()) ||
      row.story_excerpt ||
      '',
    authorName:
      cleanText($('[rel="author"]').first().text()) ||
      cleanText($('a[href*="/author/"]').first().text()) ||
      row.author_name ||
      null,
    thematicArea:
      cleanText($('a[href*="/stories/"], a[href*="/category/"]').first().text()) ||
      row.thematic_area ||
      null,
    storyText: dedupe(paragraphs).join('\n\n'),
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
  return preferredModels.length ? preferredModels : availableModels;
}

async function summarizeWithGemini(row, parsedStory) {
  const prompt = [
    'Extract a structured summary from this Better India story.',
    'Return strict JSON only.',
    'Schema:',
    '{"person_name":string|null,"contributors":[{"name":string|null,"contribution":string|null}],"contact_address":string|null,"contact_email":string|null,"contact_phone":string|null,"place":string|null,"thematic_area":string|null,"summary_of_work":string|null,"process_steps":string[],"six_m_categories":string[],"tags":string[]}',
    'Rules:',
    '- Use null when the article does not provide a reliable value.',
    '- six_m_categories must only use: Manpower, Method, Material, Machine, Money, Market.',
    '- tags should be short descriptive keywords.',
    '- person_name should be the main changemaker, founder, farmer, entrepreneur, or organisation representative the story centres on.',
    '- If multiple people or experts are quoted, contributors must capture each person and their specific advice, action, or role.',
    '- place should be the main operational place mentioned in the story.',
    '- summary_of_work must be useful and specific, not generic. Mention concrete actions, outcomes, and person-wise advice where relevant.',
    '- If the article describes a how-to, routine, method, or action plan, process_steps must contain clear ordered steps.',
    '- If the article contains multiple tips, recommendations, or expert viewpoints, summarize them distinctly instead of collapsing them into one generic paragraph.',
    `Title: ${row.title}`,
    `Thematic area from existing record: ${row.thematic_area || 'Unknown'}`,
    `Author: ${parsedStory.authorName || row.author_name || 'Unknown'}`,
    `Story excerpt: ${parsedStory.excerpt || row.story_excerpt || ''}`,
    `Story body:\n${parsedStory.storyText.slice(0, 12000)}`,
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
      lastError = new Error(raw || `Gemini request failed (${response.status})`);
      continue;
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
  throw lastError || new Error('Gemini summary generation failed.');
}

function buildSearchText(row) {
  return [
    row.title,
    row.person_name,
    row.thematic_area,
    row.place_label,
    row.location_text,
    row.summary_of_work,
    row.story_excerpt,
    row.contact_email,
    row.contact_phone,
    row.contact_address,
    (row.ai_summary?.contributors || []).map((item) => [item?.name, item?.contribution].filter(Boolean).join(' ')).join(' '),
    (row.ai_summary?.process_steps || []).join(' '),
    (row.tags || []).join(' '),
    (row.six_m_categories || []).join(' '),
  ].filter(Boolean).join(' ');
}

async function updateRow(storyUid, updates) {
  await fetchJson(`/rest/v1/better_india_stories?story_uid=eq.${encodeURIComponent(storyUid)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(updates),
  });
}

async function run() {
  const rows = await loadRows();
  let updated = 0;
  for (const row of rows) {
    const url = safeUrl(row.story_url);
    if (!url) continue;
    const html = await fetchText(url);
    const parsedStory = parseStoryPage(html, row);
    const { aiModel, summary } = await summarizeWithGemini(row, parsedStory);
    const richSummary = buildDisplaySummary(summary.summary_of_work || parsedStory.excerpt || row.story_excerpt || null, summary.contributors, summary.process_steps);
    const sixM = normalizeSixM([
      ...(summary.six_m_categories || []),
      ...inferSixMHeuristically([
        row.title,
        parsedStory.excerpt,
        parsedStory.storyText,
        summary.summary_of_work,
        ...(summary.process_steps || []),
        ...(summary.contributors || []).map((item) => `${item?.name || ''} ${item?.contribution || ''}`),
        ...(summary.tags || []),
      ].join(' ')),
    ]);
    const aiSummary = { ...summary, six_m_categories: sixM };
    const merged = {
      person_name: buildInvolvedPeopleName(summary.person_name || row.person_name || null, summary.contributors || []),
      thematic_area: summary.thematic_area || row.thematic_area || parsedStory.thematicArea || null,
      place_label: summary.place || row.place_label || null,
      contact_address: summary.contact_address || row.contact_address || row.place_label || null,
      summary_of_work: richSummary,
      six_m_categories: sixM,
      tags: dedupe([...(summary.tags || []), ...((row.tags || []).slice(0, 10))]),
      ai_model: aiModel,
      ai_summary: aiSummary,
      story_excerpt: parsedStory.excerpt || row.story_excerpt || null,
      author_name: parsedStory.authorName || row.author_name || null,
      updated_at: new Date().toISOString(),
    };
    merged.location_text = dedupe([merged.contact_address, merged.place_label]).join(' | ') || null;
    merged.search_text = buildSearchText({ ...row, ...merged, ai_summary: aiSummary });
    await updateRow(row.story_uid, merged);
    updated += 1;
    await sleep(1200);
  }
  console.log(JSON.stringify({ processed: rows.length, updated }));
}

await run();
