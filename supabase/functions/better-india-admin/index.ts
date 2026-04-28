import { createClient } from "npm:@supabase/supabase-js@2";
import { load } from "npm:cheerio@1.0.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SELCO_VENDOR_SERVICE_ROLE_KEY") ?? "";
const geminiApiKey = Deno.env.get("GEMINI_API_KEY") ?? Deno.env.get("GOOGLE_API_KEY") ?? "";
const betterIndiaBaseUrl = "https://thebetterindia.com";
const betterIndiaListingUrl = `${betterIndiaBaseUrl}/stories`;
const cronToken = Deno.env.get("BETTER_INDIA_SYNC_CRON_TOKEN") ?? "";
const MAX_STORIES_PER_RUN = 10;
const LATEST_STORY_CHECKS_PER_RUN = 3;
const STALE_RUN_MINUTES = 20;
const SIX_M_OPTIONS = ["Manpower", "Method", "Material", "Machine", "Money", "Market"];
let supabaseClient: ReturnType<typeof createClient> | null = null;

const EDITABLE_STORY_FIELDS = [
  "title",
  "person_name",
  "thematic_area",
  "place_label",
  "contact_email",
  "contact_phone",
  "contact_address",
  "six_m_categories",
  "tags",
  "summary_of_work",
  "story_url",
  "latitude",
  "longitude",
  "admin_notes",
] as const;

type ListingItem = {
  detailUrl: string;
  title: string;
  excerpt: string;
  thematicArea: string;
  publishedAt: string | null;
  authorName: string | null;
  imageUrl: string | null;
  pageNumber: number;
  pagePosition: number;
};

type StoryPageParse = {
  title: string;
  excerpt: string;
  authorName: string | null;
  publishedAt: string | null;
  thematicArea: string | null;
  coverImageUrl: string | null;
  imageUrls: string[];
  storyText: string;
  storyHtml: string;
};

type GeminiSummary = {
  person_name: string | null;
  contact_address: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  place: string | null;
  thematic_area: string | null;
  summary_of_work: string | null;
  six_m_categories: string[];
  tags: string[];
};

function getSupabaseAdmin() {
  if (!supabaseUrl || !serviceRoleKey) throw new Error("Function secrets are not configured.");
  if (supabaseClient) return supabaseClient;
  supabaseClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
  return supabaseClient;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 400) {
  return jsonResponse({ error: message }, status);
}

function requireString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeText(value: unknown) {
  return requireString(value).toLowerCase();
}

function cleanText(value: unknown) {
  return requireString(value).replace(/\s+/g, " ").trim();
}

function slugify(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "-");
}

function dedupe(values: string[]) {
  return [...new Set(values.map((value) => cleanText(value)).filter(Boolean))];
}

function safeUrl(value: string) {
  if (!value) return "";
  try {
    return new URL(value, betterIndiaBaseUrl).toString();
  } catch {
    return "";
  }
}

function isStoryUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (!/thebetterindia\.com$/i.test(parsed.hostname)) return false;
    if (parsed.pathname === "/" || parsed.pathname === "/stories" || parsed.pathname.startsWith("/stories/page")) return false;
    const path = parsed.pathname.replace(/\/+$/, "");
    if (!path || path === "/stories") return false;
    return /\/\d+\/|\/[a-z0-9-]{10,}/i.test(path);
  } catch {
    return false;
  }
}

function storyUidFromUrl(url: string) {
  try {
    const pathname = new URL(url).pathname.replace(/\/+$/, "");
    return slugify(pathname.replace(/\//g, " "));
  } catch {
    return slugify(url);
  }
}

function toNullableNumber(value: unknown) {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function toUsableCoordinate(value: unknown) {
  const num = toNullableNumber(value);
  if (num === null) return null;
  return Math.abs(num) <= 0.0001 ? null : num;
}

function extractEmails(text: string) {
  return dedupe((text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map((item) => item.toLowerCase()));
}

function normalizePhone(value: string) {
  const digits = value.replace(/[^\d]/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+91 ${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return cleanText(value);
}

function extractPhones(text: string) {
  return dedupe((text.match(/(?:\+?91[\s-]*)?[6-9]\d{2}[\s-]*\d{3}[\s-]*\d{4}/g) || []).map(normalizePhone));
}

async function fetchText(url: string) {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Better India Story Directory Sync/1.0",
    },
  });
  if (!response.ok) throw new Error(`Fetch failed for ${url}: ${response.status}`);
  return await response.text();
}

function parseDateToIso(value: string) {
  const text = cleanText(value);
  if (!text) return null;
  const timestamp = Date.parse(text);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function extractPageCount(html: string) {
  const $ = load(html);
  const numbers = $("a, span")
    .map((_, el) => Number.parseInt(cleanText($(el).text()), 10))
    .get()
    .filter((value) => Number.isFinite(value) && value > 0);
  return numbers.length ? Math.max(...numbers) : 1;
}

function parseListingPage(html: string, pageNumber: number) {
  const $ = load(html);
  const seen = new Set<string>();
  const items: ListingItem[] = [];

  $('a[href]').each((_, link) => {
    const anchor = $(link);
    const detailUrl = safeUrl(anchor.attr("href") || "");
    if (!isStoryUrl(detailUrl) || seen.has(detailUrl)) return;
    const article = anchor.closest("article, .jeg_post, .jeg_postblock_content, .td_module_wrap, .elementor-post");
    const title = cleanText(anchor.text()) || cleanText(article.find("h1,h2,h3,h4").first().text());
    if (!title || title.length < 12) return;
    const excerpt = cleanText(article.find("p").first().text());
    const thematicArea = cleanText(article.find('a[href*="/stories/"], a[href*="/category/"]').last().text());
    const metaText = cleanText(article.text());
    const publishedAt = parseDateToIso(metaText.match(/\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}\b/)?.[0] || "");
    const authorName = cleanText(metaText.match(/By\s+([A-Za-z .'-]{3,80})/i)?.[1] || "");
    const imageUrl = safeUrl(article.find("img").first().attr("src") || anchor.find("img").first().attr("src") || "");
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

async function scrapeListingPage(pageNumber: number) {
  const candidates = pageNumber === 1
    ? [betterIndiaListingUrl, `${betterIndiaListingUrl}/`]
    : [`${betterIndiaListingUrl}/page/${pageNumber}/`, `${betterIndiaListingUrl}?paged=${pageNumber}`];
  for (const url of candidates) {
    try {
      const html = await fetchText(url);
      const parsed = parseListingPage(html, pageNumber);
      if (parsed.items.length) return parsed;
    } catch {
      continue;
    }
  }
  return { items: [] as ListingItem[], pageCount: pageNumber };
}

async function scrapeAllListings() {
  const firstPage = await scrapeListingPage(1);
  const pageCount = Math.max(1, firstPage.pageCount);
  const items = [...firstPage.items];
  let emptyPages = 0;
  for (let page = 2; page <= Math.max(pageCount, 120); page += 1) {
    const result = await scrapeListingPage(page);
    if (!result.items.length) {
      emptyPages += 1;
      if (page > pageCount && emptyPages >= 2) break;
      continue;
    }
    emptyPages = 0;
    items.push(...result.items);
  }
  return dedupe(items.map((item) => item.detailUrl)).map((url) => items.find((item) => item.detailUrl === url)!).filter(Boolean);
}

function parseStoryPage(html: string, listingItem: ListingItem): StoryPageParse {
  const $ = load(html);
  const title = cleanText($("h1").first().text()) || listingItem.title;
  const excerpt =
    cleanText($('meta[name="description"]').attr("content") || "") ||
    cleanText($("main p, article p").first().text()) ||
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
    parseDateToIso($('meta[property="article:published_time"]').attr("content") || "") ||
    parseDateToIso($("time").first().attr("datetime") || "") ||
    parseDateToIso($("main, article").first().text().match(/\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}\b/)?.[0] || "") ||
    listingItem.publishedAt;
  const coverImageUrl =
    safeUrl($('meta[property="og:image"]').attr("content") || "") ||
    safeUrl($("article img, main img").first().attr("src") || "") ||
    listingItem.imageUrl ||
    null;
  const imageUrls = dedupe($("article img, main img")
    .map((_, el) => safeUrl($(el).attr("src") || ""))
    .get()
    .filter((url) => /^https?:\/\//i.test(url) && !/logo|icon|avatar/i.test(url)));
  const paragraphs = $("article p, main p")
    .map((_, el) => cleanText($(el).text()))
    .get()
    .filter((text) => text && text.length > 30 && !/advertis/i.test(text) && !/follow us/i.test(text));
  const storyText = dedupe(paragraphs).join("\n\n");
  return {
    title,
    excerpt,
    authorName,
    publishedAt,
    thematicArea,
    coverImageUrl,
    imageUrls: imageUrls.length ? imageUrls : (coverImageUrl ? [coverImageUrl] : []),
    storyText,
    storyHtml: html,
  };
}

function stripCodeFences(value: string) {
  return value.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
}

function parseJsonObject(text: string) {
  const cleaned = stripCodeFences(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Gemini response did not include valid JSON.");
    return JSON.parse(match[0]);
  }
}

function normalizeSixM(values: unknown) {
  const list = Array.isArray(values) ? values.map((item) => cleanText(String(item || ""))) : [];
  const matched = list
    .map((item) => SIX_M_OPTIONS.find((option) => option.toLowerCase() === item.toLowerCase()))
    .filter(Boolean) as string[];
  return dedupe(matched);
}

function normalizeTags(values: unknown) {
  const list = Array.isArray(values) ? values.map((item) => cleanText(String(item || ""))) : [];
  return dedupe(list).slice(0, 16);
}

async function summarizeWithGemini(listingItem: ListingItem, parsedStory: StoryPageParse): Promise<GeminiSummary> {
  if (!geminiApiKey) throw new Error("Gemini API key is not configured.");
  const prompt = [
    "Extract a structured summary from this Better India story.",
    "Return strict JSON only.",
    "Schema:",
    '{"person_name":string|null,"contact_address":string|null,"contact_email":string|null,"contact_phone":string|null,"place":string|null,"thematic_area":string|null,"summary_of_work":string|null,"six_m_categories":string[],"tags":string[]}',
    "Rules:",
    "- Use null when the article does not provide a reliable value.",
    "- six_m_categories must only use: Manpower, Method, Material, Machine, Money, Market.",
    "- tags should be short descriptive keywords.",
    "- person_name should be the main changemaker, founder, farmer, entrepreneur, or organisation representative the story centres on.",
    "- place should be the main operational place mentioned in the story.",
    "- summary_of_work should be 2-4 sentences summarising the work done.",
    `Title: ${listingItem.title}`,
    `Listing excerpt: ${listingItem.excerpt}`,
    `Thematic area from listing: ${listingItem.thematicArea || "Unknown"}`,
    `Author: ${parsedStory.authorName || "Unknown"}`,
    `Published at: ${parsedStory.publishedAt || "Unknown"}`,
    `Story body:\n${parsedStory.storyText.slice(0, 18000)}`,
  ].join("\n");

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(geminiApiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    }),
  });
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    throw new Error(raw || `Gemini request failed (${response.status})`);
  }
  const data = await response.json() as Record<string, unknown>;
  const text = String(
    (data.candidates as Array<Record<string, unknown>> | undefined)?.[0]?.content &&
    ((data.candidates as Array<Record<string, unknown>>)[0].content as Record<string, unknown>).parts &&
    (((data.candidates as Array<Record<string, unknown>>)[0].content as Record<string, unknown>).parts as Array<Record<string, unknown>>)[0]?.text || ""
  );
  const parsed = parseJsonObject(text) as Record<string, unknown>;
  return {
    person_name: cleanText(parsed.person_name) || null,
    contact_address: cleanText(parsed.contact_address) || null,
    contact_email: cleanText(parsed.contact_email) || null,
    contact_phone: cleanText(parsed.contact_phone) || null,
    place: cleanText(parsed.place) || null,
    thematic_area: cleanText(parsed.thematic_area) || null,
    summary_of_work: cleanText(parsed.summary_of_work) || null,
    six_m_categories: normalizeSixM(parsed.six_m_categories),
    tags: normalizeTags(parsed.tags),
  };
}

function buildSearchText(row: Record<string, unknown>) {
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
    (row.tags as string[] || []).join(" "),
    (row.six_m_categories as string[] || []).join(" "),
  ].filter(Boolean).join(" ");
}

function buildPersonSlug(name: string) {
  return slugify(name || "unknown-person");
}

function normalizeLocationValue(value: unknown) {
  return requireString(value)
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s*\|\s*/g, " | ")
    .trim();
}

function dedupeLocations(values: unknown[]) {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = normalizeLocationValue(value);
    const key = normalized.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function normalizeGeocodeQuery(value: string) {
  return value
    .replace(/[|]+/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildGeocodeQueries(row: Record<string, unknown>) {
  const address = normalizeGeocodeQuery(requireString(row.contact_address));
  const place = normalizeGeocodeQuery(requireString(row.place_label));
  const state = normalizeGeocodeQuery(requireString(row.state));
  const country = normalizeGeocodeQuery(requireString(row.country) || "India");
  return dedupe([
    [address, place, state, country].filter(Boolean).join(", "),
    [place, state, country].filter(Boolean).join(", "),
    [state, country].filter(Boolean).join(", "),
  ]);
}

async function geocodeStoryFallback(row: Record<string, unknown>) {
  const queries = buildGeocodeQueries(row);
  for (const query of queries) {
    if (!query) continue;
    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`, {
        headers: {
          Accept: "application/json",
          "User-Agent": "Better India Story Directory/1.0",
        },
      });
      if (!response.ok) continue;
      const data = await response.json() as Array<Record<string, unknown>>;
      const match = Array.isArray(data) ? data[0] : null;
      const latitude = toUsableCoordinate(match?.lat);
      const longitude = toUsableCoordinate(match?.lon);
      if (latitude !== null && longitude !== null) return { latitude, longitude };
    } catch {
      continue;
    }
  }
  return { latitude: null, longitude: null };
}

async function hashToken(token: string) {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function generateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function validateSession(token: string) {
  const supabase = getSupabaseAdmin();
  const tokenHash = await hashToken(token);
  const { data, error } = await supabase.from("grameee_admin_sessions").select("id, username, expires_at").eq("token_hash", tokenHash).maybeSingle();
  if (error || !data) return null;
  if (new Date(data.expires_at).getTime() <= Date.now()) {
    await supabase.from("grameee_admin_sessions").delete().eq("id", data.id);
    return null;
  }
  await supabase.from("grameee_admin_sessions").update({ last_used_at: new Date().toISOString() }).eq("id", data.id);
  return data;
}

async function verifyAdminPassword(username: string, password: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("grameee_admin_password_matches", { p_username: username, p_password: password });
  if (error) throw new Error(`Admin password verification failed: ${error.message}`);
  return Boolean(data);
}

async function handleLogin(password: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("grameee_admin_accounts").select("username, password_hash").eq("username", "admin").maybeSingle();
  if (error) return errorResponse(`Admin account lookup failed: ${error.message}`, 500);
  if (!data?.password_hash) return errorResponse("Admin account does not exist yet.", 401);
  const validPassword = await verifyAdminPassword("admin", password).catch(() => false);
  if (!validPassword) return errorResponse("Invalid admin password.", 401);

  const token = generateToken();
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await supabase.from("grameee_admin_sessions").delete().eq("username", "admin");
  const { error: sessionError } = await supabase.from("grameee_admin_sessions").insert({ username: "admin", token_hash: tokenHash, expires_at: expiresAt });
  if (sessionError) return errorResponse("Admin session could not be created.", 500);
  return jsonResponse({ token, username: "admin", expires_at: expiresAt });
}

async function handleVerify(token: string) {
  const session = await validateSession(token);
  return jsonResponse({ valid: Boolean(session), username: session?.username ?? null, expires_at: session?.expires_at ?? null });
}

async function handleLogout(token: string) {
  const supabase = getSupabaseAdmin();
  const tokenHash = await hashToken(token);
  await supabase.from("grameee_admin_sessions").delete().eq("token_hash", tokenHash);
  return jsonResponse({ ok: true });
}

async function mapLimit<T, R>(items: T[], batchSize: number, worker: (item: T) => Promise<R>) {
  const output: R[] = [];
  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    output.push(...await Promise.all(batch.map((item) => worker(item))));
  }
  return output;
}

async function getSyncState() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("better_india_sync_state").select("*").eq("state_key", "default").maybeSingle();
  if (error) throw new Error(`Could not load Better India sync state: ${error.message}`);
  if (data) return data;
  const { data: inserted, error: insertError } = await supabase
    .from("better_india_sync_state")
    .insert({ state_key: "default", last_total: 0 })
    .select("*")
    .single();
  if (insertError || !inserted) throw new Error(`Could not initialize Better India sync state: ${insertError?.message || "unknown error"}`);
  return inserted;
}

async function updateSyncState(values: Record<string, unknown>) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("better_india_sync_state")
    .upsert({ state_key: "default", updated_at: new Date().toISOString(), ...values }, { onConflict: "state_key" });
  if (error) throw new Error(`Could not update Better India sync state: ${error.message}`);
}

async function markStaleRunningSyncs() {
  const supabase = getSupabaseAdmin();
  const staleBefore = new Date(Date.now() - STALE_RUN_MINUTES * 60 * 1000).toISOString();
  const { error } = await supabase
    .from("better_india_sync_runs")
    .update({
      status: "failed",
      finished_at: new Date().toISOString(),
      error_message: "Marked failed because a newer sync started after this run stalled.",
      updated_at: new Date().toISOString(),
    })
    .eq("status", "running")
    .lt("started_at", staleBefore);
  if (error) throw new Error(`Could not update stale Better India sync runs: ${error.message}`);
}

async function handleListBetterIndiaSyncRuns(token: string) {
  const session = await validateSession(token);
  if (!session) return errorResponse("Invalid admin session.", 401);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("better_india_sync_runs").select("*").order("created_at", { ascending: false }).limit(10);
  if (error) return errorResponse("Better India sync runs could not be loaded.", 500);
  return jsonResponse({ items: data || [] });
}

async function handleUpdateBetterIndiaStory(token: string, storyUid: string, updates: Record<string, unknown>) {
  const supabase = getSupabaseAdmin();
  const session = await validateSession(token);
  if (!session) return errorResponse("Invalid admin session.", 401);
  if (!storyUid) return errorResponse("Missing story id.", 400);
  const { data: existingStory, error: existingError } = await supabase
    .from("better_india_stories")
    .select("*")
    .eq("story_uid", storyUid)
    .maybeSingle();
  if (existingError) return errorResponse(`Story lookup failed: ${existingError.message}`, 500);
  if (!existingStory) return errorResponse("Story record was not found.", 404);

  const cleanUpdates: Record<string, unknown> = {};
  for (const field of EDITABLE_STORY_FIELDS) {
    if (!(field in updates)) continue;
    if (field === "tags" || field === "six_m_categories") {
      cleanUpdates[field] = dedupe(Array.isArray(updates[field]) ? (updates[field] as unknown[]).map((item) => String(item || "")) : []);
      continue;
    }
    if (field === "latitude" || field === "longitude") {
      cleanUpdates[field] = toNullableNumber(updates[field]);
      continue;
    }
    cleanUpdates[field] = requireString(updates[field]) || null;
  }

  if (cleanUpdates.person_name) cleanUpdates.person_slug = buildPersonSlug(requireString(cleanUpdates.person_name));
  if (cleanUpdates.contact_address || cleanUpdates.place_label) {
    cleanUpdates.location_text = dedupeLocations([cleanUpdates.contact_address, cleanUpdates.place_label]).join(" | ") || null;
  }
  cleanUpdates.updated_at = new Date().toISOString();

  if ((cleanUpdates.latitude === null || cleanUpdates.latitude === undefined || cleanUpdates.longitude === null || cleanUpdates.longitude === undefined) && (cleanUpdates.place_label || cleanUpdates.contact_address)) {
    const geocoded = await geocodeStoryFallback({
      contact_address: cleanUpdates.contact_address,
      place_label: cleanUpdates.place_label,
      state: null,
      country: "India",
    });
    if (cleanUpdates.latitude === null || cleanUpdates.latitude === undefined) cleanUpdates.latitude = geocoded.latitude;
    if (cleanUpdates.longitude === null || cleanUpdates.longitude === undefined) cleanUpdates.longitude = geocoded.longitude;
  }
  cleanUpdates.search_text = buildSearchText({ ...existingStory, ...cleanUpdates });

  const { data, error } = await supabase
    .from("better_india_stories")
    .update(cleanUpdates)
    .eq("story_uid", storyUid)
    .select("*")
    .single();
  if (error) return errorResponse(`Story update failed: ${error.message}`, 500);
  return jsonResponse({ ok: true, item: data });
}

async function loadExistingStoryIds() {
  const supabase = getSupabaseAdmin();
  const rows: { story_uid: string; story_url: string }[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase.from("better_india_stories").select("story_uid, story_url").range(from, to);
    if (error) throw new Error(`Could not load existing Better India story ids: ${error.message}`);
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  return new Set(rows.map((row) => row.story_uid));
}

function chooseStoriesForRun(listingItems: ListingItem[], existingStoryIds: Set<string>) {
  const latestUnknown = listingItems
    .slice(0, 20)
    .filter((item) => !existingStoryIds.has(storyUidFromUrl(item.detailUrl)))
    .slice(0, LATEST_STORY_CHECKS_PER_RUN);
  const backlogUnknown = [...listingItems]
    .reverse()
    .filter((item) => !existingStoryIds.has(storyUidFromUrl(item.detailUrl)));
  const output: ListingItem[] = [];
  const seen = new Set<string>();
  for (const item of [...latestUnknown, ...backlogUnknown]) {
    if (seen.has(item.detailUrl)) continue;
    seen.add(item.detailUrl);
    output.push(item);
    if (output.length >= MAX_STORIES_PER_RUN) break;
  }
  return output;
}

async function insertStories(rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("better_india_stories").upsert(rows, { onConflict: "story_uid" });
  if (error) throw new Error(`Better India story insert failed: ${error.message}`);
}

async function runBetterIndiaSync(requestedBy: string) {
  const supabase = getSupabaseAdmin();
  await markStaleRunningSyncs();
  const syncState = await getSyncState();
  const { data: runData, error: runError } = await supabase.from("better_india_sync_runs").insert({ status: "running", requested_by: requestedBy, started_at: new Date().toISOString() }).select("id").single();
  if (runError || !runData?.id) throw new Error("Better India sync run could not be created.");
  const runId = String(runData.id);

  try {
    const listingItems = await scrapeAllListings();
    const existingStoryIds = await loadExistingStoryIds();
    const selectedListings = chooseStoriesForRun(listingItems, existingStoryIds);

    await updateSyncState({
      last_started_at: new Date().toISOString(),
      last_total: listingItems.length,
      last_seen_latest_story_url: listingItems[0]?.detailUrl || syncState.last_seen_latest_story_url || null,
    });

    if (!selectedListings.length) {
      await updateSyncState({ last_finished_at: new Date().toISOString() });
      await supabase.from("better_india_sync_runs").update({
        status: "success",
        finished_at: new Date().toISOString(),
        story_count: 0,
        error_message: "No new Better India stories were found in this run.",
        updated_at: new Date().toISOString(),
      }).eq("id", runId);
      return { storyCount: 0 };
    }

    const processedRows = await mapLimit(selectedListings, 2, async (listingItem) => {
      const html = await fetchText(listingItem.detailUrl);
      const parsedStory = parseStoryPage(html, listingItem);
      const aiSummary = await summarizeWithGemini(listingItem, parsedStory);
      const heuristicsEmails = extractEmails(parsedStory.storyText);
      const heuristicsPhones = extractPhones(parsedStory.storyText);
      const title = parsedStory.title || listingItem.title;
      const personName = aiSummary.person_name || title.match(/^([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3})/)?.[1] || "Unknown Person";
      const place = aiSummary.place || parsedStory.storyText.match(/\b(?:in|from|at)\s+([A-Z][A-Za-z .'-]+(?:,\s*[A-Z][A-Za-z .'-]+){0,2})/)?.[1] || null;
      const storyUid = storyUidFromUrl(listingItem.detailUrl);
      const row: Record<string, unknown> = {
        story_uid: storyUid,
        story_url: listingItem.detailUrl,
        title,
        person_name: personName,
        person_slug: buildPersonSlug(personName),
        author_name: parsedStory.authorName || listingItem.authorName || null,
        thematic_area: aiSummary.thematic_area || parsedStory.thematicArea || listingItem.thematicArea || null,
        place_label: place,
        location_text: dedupeLocations([aiSummary.contact_address, place]).join(" | ") || null,
        state: place,
        country: "India",
        contact_email: aiSummary.contact_email || heuristicsEmails[0] || null,
        contact_phone: aiSummary.contact_phone || heuristicsPhones[0] || null,
        contact_address: aiSummary.contact_address || place,
        summary_of_work: aiSummary.summary_of_work || parsedStory.excerpt || listingItem.excerpt || null,
        story_excerpt: parsedStory.excerpt || listingItem.excerpt || null,
        six_m_categories: aiSummary.six_m_categories,
        tags: dedupe([...(aiSummary.tags || []), ...(parsedStory.thematicArea ? [parsedStory.thematicArea] : [])]),
        cover_image_url: parsedStory.coverImageUrl || listingItem.imageUrl || null,
        story_image_urls: parsedStory.imageUrls,
        latitude: null,
        longitude: null,
        source_published_at: parsedStory.publishedAt || listingItem.publishedAt || null,
        source_listing_page: listingItem.pageNumber,
        source_listing_position: listingItem.pagePosition,
        source_status: "synced",
        admin_notes: null,
        ai_model: "gemini-2.0-flash",
        ai_summary: aiSummary,
        raw_story: {
          listing: listingItem,
          parsed_excerpt: parsedStory.excerpt,
          parsed_author: parsedStory.authorName,
        },
        synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const geocoded = await geocodeStoryFallback(row);
      row.latitude = geocoded.latitude;
      row.longitude = geocoded.longitude;
      row.search_text = buildSearchText(row);
      return row;
    });

    await insertStories(processedRows);
    await updateSyncState({
      last_finished_at: new Date().toISOString(),
      last_total: listingItems.length,
      last_seen_latest_story_url: listingItems[0]?.detailUrl || null,
    });

    await supabase.from("better_india_sync_runs").update({
      status: "success",
      finished_at: new Date().toISOString(),
      story_count: processedRows.length,
      error_message: null,
      updated_at: new Date().toISOString(),
    }).eq("id", runId);

    return { storyCount: processedRows.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Better India story sync failed.";
    await updateSyncState({ last_finished_at: new Date().toISOString() }).catch(() => null);
    await supabase.from("better_india_sync_runs").update({
      status: "failed",
      finished_at: new Date().toISOString(),
      error_message: message,
      updated_at: new Date().toISOString(),
    }).eq("id", runId);
    throw error;
  }
}

async function handleSyncBetterIndiaStories(token: string) {
  const session = await validateSession(token);
  if (!session) return errorResponse("Invalid admin session.", 401);
  try {
    const result = await runBetterIndiaSync(session.username);
    return jsonResponse({ ok: true, ...result });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Better India story sync failed.", 500);
  }
}

async function handleScheduledSync(receivedToken: string) {
  if (!cronToken) return errorResponse("Scheduled sync is not configured.", 403);
  if (receivedToken !== cronToken) return errorResponse("Invalid cron token.", 403);
  try {
    const result = await runBetterIndiaSync("scheduled");
    return jsonResponse({ ok: true, ...result });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Scheduled Better India sync failed.", 500);
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return errorResponse("Method not allowed.", 405);
  if (!supabaseUrl || !serviceRoleKey) return errorResponse("Function secrets are not configured.", 500);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body.", 400);
  }

  const action = requireString(body.action);
  const token = requireString(body.token);
  const password = requireString(body.password);
  const storyUid = requireString(body.storyUid);
  const receivedCronToken = requireString(body.cronToken);
  const updates = (body.updates && typeof body.updates === "object" && !Array.isArray(body.updates)) ? body.updates as Record<string, unknown> : {};

  switch (action) {
    case "login":
      return await handleLogin(password);
    case "verify":
      return await handleVerify(token);
    case "logout":
      return await handleLogout(token);
    case "listBetterIndiaSyncRuns":
      return await handleListBetterIndiaSyncRuns(token);
    case "syncBetterIndiaStories":
      return await handleSyncBetterIndiaStories(token);
    case "updateBetterIndiaStory":
      return await handleUpdateBetterIndiaStory(token, storyUid, updates);
    case "scheduledSync":
      return await handleScheduledSync(receivedCronToken);
    default:
      return errorResponse("Unknown admin action.", 400);
  }
});
