import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SELCO_VENDOR_SERVICE_ROLE_KEY") ?? "";
const githubToken = Deno.env.get("GITHUB_ACTIONS_TOKEN") ?? Deno.env.get("GITHUB_PAT") ?? "";
const githubRepoOwner = Deno.env.get("GITHUB_REPO_OWNER") ?? "tanmaymukherji";
const githubRepoName = Deno.env.get("GITHUB_REPO_NAME") ?? "better-india-story-directory";
const githubWorkflowId = Deno.env.get("GITHUB_WORKFLOW_ID") ?? "sync-better-india-directory.yml";
const staleRunMinutes = Math.max(5, Number(Deno.env.get("BETTER_INDIA_STALE_RUN_MINUTES") ?? "20"));
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

function dedupe(values: string[]) {
  return [...new Set(values.map((value) => requireString(value)).filter(Boolean))];
}

function slugify(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "-");
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

function toNullableNumber(value: unknown) {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
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

async function handleListBetterIndiaSyncRuns(token: string) {
  const session = await validateSession(token);
  if (!session) return errorResponse("Invalid admin session.", 401);
  const supabase = getSupabaseAdmin();
  const staleBefore = new Date(Date.now() - staleRunMinutes * 60 * 1000).toISOString();
  await supabase
    .from("better_india_sync_runs")
    .update({
      status: "failed",
      finished_at: new Date().toISOString(),
      error_message: "Marked failed because the sync run exceeded the expected time window.",
      updated_at: new Date().toISOString(),
    })
    .eq("status", "running")
    .lt("started_at", staleBefore);
  const { data, error } = await supabase.from("better_india_sync_runs").select("*").order("created_at", { ascending: false }).limit(10);
  if (error) return errorResponse("Better India sync runs could not be loaded.", 500);
  return jsonResponse({ items: data || [] });
}

async function geocodeStoryFallback(row: Record<string, unknown>) {
  const queries = dedupe([
    [row.contact_address, row.place_label, row.state, row.country || "India"].filter(Boolean).join(", "),
    [row.place_label, row.state, row.country || "India"].filter(Boolean).join(", "),
    [row.state, row.country || "India"].filter(Boolean).join(", "),
  ]);
  for (const query of queries) {
    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`, {
        headers: {
          Accept: "application/json",
          "User-Agent": "Better India Story Directory/2.0",
        },
      });
      if (!response.ok) continue;
      const data = await response.json() as Array<Record<string, unknown>>;
      const match = Array.isArray(data) ? data[0] : null;
      const latitude = toNullableNumber(match?.lat);
      const longitude = toNullableNumber(match?.lon);
      if (latitude !== null && longitude !== null && (Math.abs(latitude) > 0.0001 || Math.abs(longitude) > 0.0001)) {
        return { latitude, longitude };
      }
    } catch {
      continue;
    }
  }
  return { latitude: null, longitude: null };
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
  if ((cleanUpdates.latitude === null || cleanUpdates.latitude === undefined || cleanUpdates.longitude === null || cleanUpdates.longitude === undefined) && (cleanUpdates.place_label || cleanUpdates.contact_address)) {
    const geocoded = await geocodeStoryFallback({
      contact_address: cleanUpdates.contact_address,
      place_label: cleanUpdates.place_label,
      state: existingStory.state,
      country: existingStory.country || "India",
    });
    if (cleanUpdates.latitude === null || cleanUpdates.latitude === undefined) cleanUpdates.latitude = geocoded.latitude;
    if (cleanUpdates.longitude === null || cleanUpdates.longitude === undefined) cleanUpdates.longitude = geocoded.longitude;
  }
  cleanUpdates.search_text = buildSearchText({ ...existingStory, ...cleanUpdates });
  cleanUpdates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("better_india_stories")
    .update(cleanUpdates)
    .eq("story_uid", storyUid)
    .select("*")
    .single();
  if (error) return errorResponse(`Story update failed: ${error.message}`, 500);
  return jsonResponse({ ok: true, item: data });
}

async function triggerGitHubWorkflow(requestedBy: string) {
  if (!githubToken) throw new Error("GITHUB_ACTIONS_TOKEN or GITHUB_PAT is not configured.");
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(githubRepoOwner)}/${encodeURIComponent(githubRepoName)}/actions/workflows/${encodeURIComponent(githubWorkflowId)}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "better-india-admin/2.0",
    },
    body: JSON.stringify({
      ref: "main",
      inputs: {
        requested_by: requestedBy || "admin",
      },
    }),
  });
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    throw new Error(raw || `GitHub workflow dispatch failed (${response.status}).`);
  }
}

async function handleSyncBetterIndiaStories(token: string) {
  const session = await validateSession(token);
  if (!session) return errorResponse("Invalid admin session.", 401);
  try {
    await triggerGitHubWorkflow(session.username || "admin");
    return jsonResponse({
      ok: true,
      queued: true,
      message: "Better India sync queued in GitHub Actions. Refresh sync history in a minute to see the new run.",
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Better India sync could not be queued.", 500);
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
    default:
      return errorResponse("Unknown admin action.", 400);
  }
});
