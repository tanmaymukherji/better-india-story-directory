window.BetterIndiaStore = (() => {
  const STORIES_TABLE = () => (window.APP_CONFIG && window.APP_CONFIG.BETTER_INDIA_STORIES_TABLE) || 'better_india_stories';
  const ADMIN_API_URL = () => `${String(window.APP_CONFIG?.SUPABASE_URL || '').replace(/\/$/, '')}/functions/v1/better-india-admin`;
  let client = null;

  function normalizeText(value) {
    return String(value || '').trim().toLowerCase();
  }

  function uniqueValues(values) {
    return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
  }

  function getClient() {
    if (client) return client;
    const config = window.APP_CONFIG || {};
    if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY) throw new Error('Missing Supabase config. Check config.js.');
    if (!window.supabase || typeof window.supabase.createClient !== 'function') throw new Error('Supabase client library failed to load.');
    client = window.supabase.createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY);
    return client;
  }

  function buildPersonSlug(name) {
    const slug = String(name || '')
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[-\s]+/g, '-');
    return slug || 'unknown-person';
  }

  function groupPeople(stories) {
    const peopleMap = new Map();
    stories.forEach((story) => {
      const name = String(story.person_name || '').trim() || 'Unknown Person';
      const key = normalizeText(name);
      const current = peopleMap.get(key) || {
        person_slug: buildPersonSlug(name),
        person_name: name,
        place_label: '',
        contact_email: '',
        contact_phone: '',
        contact_address: '',
        tags: [],
        thematic_areas: [],
        six_m_categories: [],
        stories: [],
        latitude: null,
        longitude: null,
      };
      current.person_name = current.person_name || name;
      current.place_label = current.place_label || story.place_label || '';
      current.contact_email = current.contact_email || story.contact_email || '';
      current.contact_phone = current.contact_phone || story.contact_phone || '';
      current.contact_address = current.contact_address || story.contact_address || '';
      current.latitude = current.latitude ?? story.latitude ?? null;
      current.longitude = current.longitude ?? story.longitude ?? null;
      current.tags = uniqueValues([...(current.tags || []), ...(story.tags || [])]);
      current.thematic_areas = uniqueValues([...(current.thematic_areas || []), story.thematic_area]);
      current.six_m_categories = uniqueValues([...(current.six_m_categories || []), ...(story.six_m_categories || [])]);
      current.stories.push(story);
      peopleMap.set(key, current);
    });
    return Array.from(peopleMap.values()).sort((left, right) => left.person_name.localeCompare(right.person_name));
  }

  async function fetchAllStories(errorPrefix) {
    const supabase = getClient();
    const stories = [];
    const pageSize = 1000;
    let from = 0;
    while (true) {
      const result = await supabase
        .from(STORIES_TABLE())
        .select('*')
        .order('source_published_at', { ascending: false })
        .order('title')
        .range(from, from + pageSize - 1);
      if (result.error) throw new Error(`${errorPrefix}: ${result.error.message}`);
      const batch = result.data || [];
      stories.push(...batch);
      if (batch.length < pageSize) break;
      from += pageSize;
    }
    return stories;
  }

  async function loadStories() {
    const stories = await fetchAllStories('Story load failed');
    return {
      stories,
      people: groupPeople(stories),
    };
  }

  async function loadAdminData() {
    const stories = await fetchAllStories('Admin story load failed');
    return {
      stories,
    };
  }

  async function adminRequest(action, payload = {}) {
    const config = window.APP_CONFIG || {};
    const response = await fetch(ADMIN_API_URL(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: String(config.SUPABASE_ANON_KEY || ''),
        Authorization: `Bearer ${String(config.SUPABASE_ANON_KEY || '')}`,
      },
      body: JSON.stringify({ action, ...payload }),
    });
    const rawText = await response.text().catch(() => '');
    let data = null;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {}
    if (!response.ok) throw new Error(data?.error || rawText || `Admin request failed (${response.status}).`);
    return data;
  }

  return {
    loadStories,
    loadAdminData,
    adminRequest,
    buildPersonSlug,
    groupPeople,
  };
})();
