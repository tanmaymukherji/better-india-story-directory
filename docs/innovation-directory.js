const directoryState = {
  stories: [],
  people: [],
  filteredStories: [],
  currentPage: 1,
  pageSize: 12,
  hasSearched: false,
  geocodeCache: new Map(),
  map: null,
  mapReady: false,
  mapLoadPromise: null,
  markers: [],
  selectedStoryId: null,
};

const INDIA_CENTER = { lat: 22.9734, lng: 78.6569 };
const SEARCH_STATE_KEY = 'better_india_story_search_state_v1';
const SIX_M_OPTIONS = ['Manpower', 'Method', 'Material', 'Machine', 'Money', 'Market'];
const searchEls = {
  name: document.getElementById('search-name'),
  thematic: document.getElementById('search-thematic'),
  sixm: document.getElementById('search-sixm'),
  place: document.getElementById('search-place'),
  keyword: document.getElementById('search-keyword'),
};
const resultsEl = document.getElementById('vendor-results');
const mapListEl = document.getElementById('map-results-list');
const mapStoryPanelEl = document.getElementById('map-story-panel');
const statusEl = document.getElementById('directory-status');
const resultsSummaryEl = document.getElementById('results-summary');
const paginationEls = [
  document.getElementById('results-pagination-top'),
  document.getElementById('results-pagination-bottom'),
];
const DEFAULT_MARKER_HTML = '<div style="position:relative;width:20px;height:20px;border-radius:999px;background:#d97706;border:3px solid #fff;box-shadow:0 0 0 7px rgba(217,119,6,.18),0 8px 18px rgba(15,23,42,.24);"></div>';

function esc(value) {
  return String(value || '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function tokenize(value) {
  return normalizeText(value).split(/[^a-z0-9]+/).filter(Boolean);
}

function uniqueSortedValues(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
}

function getSelectedValues(selectEl) {
  if (!selectEl) return [];
  return Array.from(selectEl.querySelectorAll('input[type="checkbox"]:checked'))
    .map((input) => String(input.value || '').trim())
    .filter(Boolean);
}

function setSelectedValues(selectEl, values) {
  if (!selectEl) return;
  const wanted = new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean));
  Array.from(selectEl.querySelectorAll('input[type="checkbox"]')).forEach((input) => {
    input.checked = wanted.has(input.value);
  });
}

function populateSelectOptions(selectEl, values, placeholder) {
  if (!selectEl) return;
  const previousValue = selectEl.value;
  selectEl.innerHTML = '';
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = placeholder;
  selectEl.appendChild(defaultOption);
  values.forEach((value) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    selectEl.appendChild(option);
  });
  selectEl.value = values.includes(previousValue) ? previousValue : '';
}

function populateFilterOptions() {
  populateSelectOptions(
    searchEls.name,
    uniqueSortedValues(directoryState.stories.map((story) => story.person_name)),
    'All names'
  );
  populateSelectOptions(
    searchEls.thematic,
    uniqueSortedValues(directoryState.stories.map((story) => story.thematic_area)),
    'All thematic areas'
  );
  const previousSixM = getSelectedValues(searchEls.sixm);
  searchEls.sixm.innerHTML = SIX_M_OPTIONS.map((value) => `
    <label class="checkbox-item">
      <input type="checkbox" value="${esc(value)}" />
      <span>${esc(value)}</span>
    </label>
  `).join('');
  setSelectedValues(searchEls.sixm, previousSixM);
}

function persistSearchState() {
  const snapshot = {
    search: {
      name: searchEls.name.value,
      thematic: searchEls.thematic.value,
      sixm: getSelectedValues(searchEls.sixm),
      place: searchEls.place.value,
      keyword: searchEls.keyword.value,
    },
    currentPage: directoryState.currentPage,
    hasSearched: directoryState.hasSearched,
    selectedStoryId: directoryState.selectedStoryId,
  };
  try {
    window.sessionStorage.setItem(SEARCH_STATE_KEY, JSON.stringify(snapshot));
  } catch {}
}

function restoreSearchState() {
  try {
    const raw = window.sessionStorage.getItem(SEARCH_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function applySearchSnapshot(snapshot) {
  if (!snapshot?.search) return;
  searchEls.name.value = String(snapshot.search.name || '');
  searchEls.thematic.value = String(snapshot.search.thematic || '');
  setSelectedValues(searchEls.sixm, Array.isArray(snapshot.search.sixm) ? snapshot.search.sixm : []);
  searchEls.place.value = String(snapshot.search.place || '');
  searchEls.keyword.value = String(snapshot.search.keyword || '');
  directoryState.currentPage = Number(snapshot.currentPage || 1);
  directoryState.selectedStoryId = snapshot.selectedStoryId || null;
}

function buildStoryIndex(story) {
  return {
    name: normalizeText(story.person_name),
    thematic: normalizeText(story.thematic_area),
    sixm: (story.six_m_categories || []).map(normalizeText).filter(Boolean),
    place: [
      story.place_label,
      story.contact_address,
      story.location_text,
      story.state,
      story.country,
    ].map(normalizeText).join(' '),
    keyword: [
      story.title,
      story.person_name,
      story.thematic_area,
      story.place_label,
      story.location_text,
      story.state,
      story.country,
      story.summary_of_work,
      story.story_excerpt,
      story.contact_email,
      story.contact_phone,
      story.contact_address,
      (story.tags || []).join(' '),
      (story.six_m_categories || []).join(' '),
      story.search_text,
    ].map(normalizeText).join(' '),
  };
}

function scoreAgainstTokens(haystack, tokens, weight) {
  if (!tokens.length) return 0;
  const haystackTokens = tokenize(haystack);
  if (!haystackTokens.length) return null;
  let score = 0;
  for (const token of tokens) {
    if (haystackTokens.includes(token)) {
      score += weight * 3;
      continue;
    }
    if (haystackTokens.some((candidate) => candidate.startsWith(token))) {
      score += weight * 2;
      continue;
    }
    return null;
  }
  return score;
}

function getScoredStories(filters) {
  return directoryState.stories
    .map((story) => ({ story, score: scoreStory(story, filters) }))
    .filter((entry) => entry.score !== null)
    .sort((left, right) => Number(right.score) - Number(left.score) || String(right.story.source_published_at || '').localeCompare(String(left.story.source_published_at || '')));
}

function getFilters() {
  const name = normalizeText(searchEls.name.value);
  const thematic = normalizeText(searchEls.thematic.value);
  const sixm = getSelectedValues(searchEls.sixm).map(normalizeText).filter(Boolean);
  const place = normalizeText(searchEls.place.value);
  const keyword = normalizeText(searchEls.keyword.value);
  return {
    namePhrase: name,
    thematicPhrase: thematic,
    sixmValues: sixm,
    placePhrase: place,
    keywordPhrase: keyword,
    nameTokens: tokenize(name),
    thematicTokens: tokenize(thematic),
    placeTokens: tokenize(place),
    keywordTokens: tokenize(keyword),
  };
}

function hasAnyFilter(filters) {
  return Boolean(
    filters.nameTokens.length ||
    filters.thematicTokens.length ||
    filters.sixmValues.length ||
    filters.placeTokens.length ||
    filters.keywordTokens.length
  );
}

function scoreStory(story, filters) {
  const index = story._searchIndex || (story._searchIndex = buildStoryIndex(story));
  let score = 0;
  const nameScore = scoreAgainstTokens(index.name, filters.nameTokens, 22);
  if (nameScore === null) return null;
  score += nameScore;
  const thematicScore = scoreAgainstTokens(index.thematic, filters.thematicTokens, 18);
  if (thematicScore === null) return null;
  score += thematicScore;
  if (filters.sixmValues.length) {
    const storySixM = new Set(index.sixm);
    if (!filters.sixmValues.every((value) => storySixM.has(value))) return null;
    score += filters.sixmValues.length * 20;
  }
  const placeScore = scoreAgainstTokens(index.place, filters.placeTokens, 12);
  if (placeScore === null) return null;
  score += placeScore;
  const keywordScore = scoreAgainstTokens(index.keyword, filters.keywordTokens, 10);
  if (keywordScore === null) return null;
  score += keywordScore;
  if (filters.keywordPhrase && index.keyword.includes(filters.keywordPhrase)) score += 32;
  if (filters.namePhrase && index.name.includes(filters.namePhrase)) score += 24;
  if (filters.thematicPhrase && index.thematic.includes(filters.thematicPhrase)) score += 18;
  if (story.contact_email) score += 2;
  if (story.contact_phone) score += 2;
  if (story.latitude && story.longitude) score += 4;
  return score;
}

function setCounts() {
  document.getElementById('story-total-count').textContent = String(directoryState.stories.length);
  document.getElementById('name-total-count').textContent = String(directoryState.people.length);
  document.getElementById('filtered-story-count').textContent = String(directoryState.filteredStories.length);
}

function getPageCount() {
  return Math.max(1, Math.ceil(directoryState.filteredStories.length / directoryState.pageSize));
}

function getPageResults() {
  const start = (directoryState.currentPage - 1) * directoryState.pageSize;
  return directoryState.filteredStories.slice(start, start + directoryState.pageSize);
}

function setSelectedStory(storyId) {
  directoryState.selectedStoryId = storyId || null;
  document.querySelectorAll('[data-story-card]').forEach((card) => {
    card.classList.toggle('active', card.dataset.storyCard === storyId);
  });
  document.querySelectorAll('[data-focus-story]').forEach((item) => {
    item.classList.toggle('active', item.dataset.focusStory === storyId);
  });
}

function focusStory(storyId, options = {}) {
  if (!storyId) return;
  setSelectedStory(storyId);
  persistSearchState();
  if (!options.scroll) return;
  const escapedId = window.CSS?.escape ? window.CSS.escape(storyId) : storyId.replace(/"/g, '\\"');
  const card = document.querySelector(`[data-story-card="${escapedId}"]`);
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function formatPublishedDate(value) {
  if (!value) return 'Date not listed';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString('en-IN', { dateStyle: 'medium' });
}

function renderSixM(story) {
  const categories = Array.isArray(story.six_m_categories) ? story.six_m_categories.filter(Boolean) : [];
  if (!categories.length) return '';
  return `<div class="innovation-chip-row">${categories.map((item) => `<span class="innovation-chip">${esc(item)}</span>`).join('')}</div>`;
}

function renderTags(story) {
  const tags = Array.isArray(story.tags) ? story.tags.filter(Boolean).slice(0, 8) : [];
  if (!tags.length) return '<p><strong>Tags:</strong> Not listed</p>';
  return `<p><strong>Tags:</strong> ${esc(tags.join(', '))}</p>`;
}

function renderStoryCard(story) {
  return `
    <article class="admin-card admin-search-card" data-story-card="${esc(story.story_uid)}">
      <div class="vendor-result-top">
        <div>
          <h4>${esc(story.title || 'Untitled story')}</h4>
          <p>${esc(story.person_name || 'Unknown person')} | ${esc(story.place_label || 'Place not listed')}</p>
        </div>
        <span class="admin-badge approved">${esc(story.thematic_area || 'General')}</span>
      </div>
      <p><strong>Published:</strong> ${esc(formatPublishedDate(story.source_published_at))}</p>
      <p>${esc(story.summary_of_work || story.story_excerpt || 'No summary saved yet.')}</p>
      ${renderSixM(story)}
      ${renderTags(story)}
      <p><strong>Contact:</strong> ${esc(story.contact_email || 'No email')} | ${esc(story.contact_phone || 'No phone')}</p>
      <div class="btn-group">
        <a class="btn btn-small" href="./product-detail.html?story=${encodeURIComponent(story.story_uid)}">View Details</a>
        <a class="btn btn-warning btn-small" href="${esc(story.story_url || '#')}" target="_blank" rel="noreferrer">View on Better India</a>
      </div>
    </article>
  `;
}

function renderResults() {
  if (!directoryState.hasSearched) {
    resultsEl.innerHTML = '<article class="vendor-empty-state">Use the filters on the left and run a search to load Better India story results.</article>';
    return;
  }
  const pageResults = getPageResults();
  resultsEl.innerHTML = pageResults.length
    ? pageResults.map(renderStoryCard).join('')
    : '<article class="admin-card"><p>No stories matched the current filters.</p></article>';

  Array.from(resultsEl.querySelectorAll('[data-story-card]')).forEach((card) => {
    card.addEventListener('click', (event) => {
      if (event.target.closest('a')) return;
      focusStory(card.dataset.storyCard, { scroll: false });
    });
  });
  setSelectedStory(directoryState.selectedStoryId);
}

function renderPagination() {
  const pageCount = getPageCount();
  paginationEls.forEach((container) => {
    if (!container) return;
    container.innerHTML = '';
    if (!directoryState.hasSearched || !directoryState.filteredStories.length) return;
    if (pageCount <= 1) return;
    const prev = document.createElement('button');
    prev.className = 'btn btn-small';
    prev.type = 'button';
    prev.textContent = 'Previous';
    prev.disabled = directoryState.currentPage <= 1;
    prev.addEventListener('click', () => goToPage(directoryState.currentPage - 1));
    const next = document.createElement('button');
    next.className = 'btn btn-small';
    next.type = 'button';
    next.textContent = 'Next';
    next.disabled = directoryState.currentPage >= pageCount;
    next.addEventListener('click', () => goToPage(directoryState.currentPage + 1));
    const meta = document.createElement('span');
    meta.className = 'section-note';
    meta.textContent = `Page ${directoryState.currentPage} of ${pageCount}`;
    container.append(prev, meta, next);
  });
}

function updateResultsSummary() {
  if (!directoryState.filteredStories.length) {
    resultsSummaryEl.textContent = directoryState.hasSearched
      ? 'No stories matched the current filters.'
      : 'Run a parametric search to view matching stories.';
    return;
  }
  const pageResults = getPageResults();
  const start = (directoryState.currentPage - 1) * directoryState.pageSize + 1;
  const end = start + pageResults.length - 1;
  resultsSummaryEl.textContent = `Showing ${start}-${end} of ${directoryState.filteredStories.length} matched stories.`;
}

function goToPage(pageNumber) {
  directoryState.currentPage = Math.min(Math.max(1, pageNumber), getPageCount());
  renderResults();
  renderPagination();
  updateResultsSummary();
  renderMapResults();
  persistSearchState();
}

function hideMapStoryPanel() {
  if (!mapStoryPanelEl) return;
  mapStoryPanelEl.hidden = true;
  mapStoryPanelEl.innerHTML = '';
}

function showMapStoryPanel(story) {
  if (!mapStoryPanelEl || !story) return;
  mapStoryPanelEl.innerHTML = `
    <div class="vendor-map-story-panel-header">
      <div>
        <h4>${esc(story.title || 'Untitled story')}</h4>
        <p>${esc(story.person_name || 'Unknown person')} | ${esc(story.place_label || 'Place not listed')}</p>
      </div>
      <button type="button" class="vendor-map-story-panel-close" id="close-map-story-panel">Close</button>
    </div>
    <p>${esc(story.summary_of_work || story.story_excerpt || 'No summary available.')}</p>
    <div class="btn-group">
      <a class="btn btn-small" href="./product-detail.html?story=${encodeURIComponent(story.story_uid)}">View Details</a>
      <a class="btn btn-warning btn-small" href="${esc(story.story_url || '#')}" target="_blank" rel="noreferrer">View on Better India</a>
    </div>
  `;
  mapStoryPanelEl.hidden = false;
  mapStoryPanelEl.querySelector('#close-map-story-panel')?.addEventListener('click', hideMapStoryPanel);
}

function runSearch() {
  const filters = getFilters();
  directoryState.hasSearched = hasAnyFilter(filters);
  const scored = directoryState.hasSearched ? getScoredStories(filters) : [];
  directoryState.filteredStories = scored.map((entry) => entry.story);
  directoryState.currentPage = 1;
  setCounts();
  renderResults();
  renderPagination();
  updateResultsSummary();
  hideMapStoryPanel();
  renderMapResults();
  persistSearchState();
}

function restoreSavedSearch(snapshot) {
  if (!snapshot?.hasSearched) return false;
  applySearchSnapshot(snapshot);
  const filters = getFilters();
  if (!hasAnyFilter(filters)) return false;
  directoryState.hasSearched = true;
  directoryState.filteredStories = getScoredStories(filters).map((entry) => entry.story);
  directoryState.currentPage = Math.min(Math.max(1, Number(snapshot.currentPage || 1)), getPageCount());
  directoryState.selectedStoryId = snapshot.selectedStoryId || null;
  setCounts();
  renderResults();
  renderPagination();
  updateResultsSummary();
  renderMapResults();
  persistSearchState();
  return true;
}

function shouldRestoreSnapshot(params) {
  if (params.get('restore') === '1') return true;
  const referrer = String(document.referrer || '');
  if (referrer && referrer.startsWith(window.location.origin)) {
    try {
      const referrerUrl = new URL(referrer);
      if (['/product-detail.html', '/vendor-detail.html'].includes(referrerUrl.pathname)) return true;
    } catch {}
  }
  const navigationEntry = window.performance?.getEntriesByType?.('navigation')?.[0];
  return navigationEntry?.type === 'back_forward';
}

function clearSearch() {
  searchEls.name.value = '';
  searchEls.thematic.value = '';
  setSelectedValues(searchEls.sixm, []);
  searchEls.place.value = '';
  searchEls.keyword.value = '';
  directoryState.filteredStories = [];
  directoryState.currentPage = 1;
  directoryState.hasSearched = false;
  directoryState.selectedStoryId = null;
  setCounts();
  renderResults();
  renderPagination();
  updateResultsSummary();
  hideMapStoryPanel();
  renderMapResults();
  persistSearchState();
}

function ensureMapCss() {
  if (document.getElementById('mappls-web-sdk-css')) return;
  const link = document.createElement('link');
  link.id = 'mappls-web-sdk-css';
  link.rel = 'stylesheet';
  link.href = 'https://apis.mappls.com/vector_map/assets/v3.5/mappls-glob.css';
  document.head.appendChild(link);
}

async function loadMapSdk() {
  const key = String(window.APP_CONFIG?.MAPMYINDIA_MAP_KEY || '').trim();
  if (!key) {
    document.getElementById('results-map').innerHTML = '<div class="vendor-map-placeholder">Add `MAPMYINDIA_MAP_KEY` in `config.js` to enable the map.</div>';
    return false;
  }
  if (window.mappls?.Map) return true;
  ensureMapCss();
  const urls = [
    `https://sdk.mappls.com/map/sdk/web?v=3.0&access_token=${encodeURIComponent(key)}`,
    `https://sdk.mappls.com/map/sdk/web?v=3.0&layer=vector&access_token=${encodeURIComponent(key)}`,
    `https://apis.mappls.com/advancedmaps/api/${encodeURIComponent(key)}/map_sdk?layer=vector&v=3.0`,
  ];
  for (const src of urls) {
    try {
      await new Promise((resolve, reject) => {
        document.querySelectorAll('script[data-mappls-sdk="true"]').forEach((node) => node.remove());
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.defer = true;
        script.dataset.mapplsSdk = 'true';
        script.onload = () => window.mappls?.Map ? resolve() : reject(new Error('Mappls SDK unavailable'));
        script.onerror = reject;
        document.head.appendChild(script);
      });
      return true;
    } catch {}
  }
  document.getElementById('results-map').innerHTML = '<div class="vendor-map-placeholder">The MapmyIndia SDK could not be loaded for this page.</div>';
  return false;
}

async function ensureMap() {
  if (directoryState.mapReady) return true;
  if (directoryState.mapLoadPromise) return directoryState.mapLoadPromise;
  const loaded = await loadMapSdk();
  if (!loaded || !window.mappls?.Map) return false;
  directoryState.mapLoadPromise = new Promise((resolve) => {
    directoryState.map = new window.mappls.Map('results-map', {
      center: INDIA_CENTER,
      zoom: 4.8,
      zoomControl: true,
      geolocation: false,
      location: false,
    });
    let settled = false;
    const markReady = () => {
      if (settled) return;
      settled = true;
      directoryState.mapReady = true;
      resolve(true);
    };
    directoryState.map?.on?.('load', markReady);
    directoryState.map?.addListener?.('load', markReady);
    window.setTimeout(markReady, 1500);
  });
  return directoryState.mapLoadPromise;
}

async function geocodeStory(story) {
  const cacheKey = story.story_uid;
  if (directoryState.geocodeCache.has(cacheKey)) return directoryState.geocodeCache.get(cacheKey);
  const lat = Number(story.latitude);
  const lng = Number(story.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng) && (Math.abs(lat) > 0.0001 || Math.abs(lng) > 0.0001)) {
    const point = { lat, lng };
    directoryState.geocodeCache.set(cacheKey, point);
    return point;
  }
  const queryCandidates = [
    [story.contact_address, story.place_label, story.state, story.country].filter(Boolean).join(', '),
    [story.place_label, story.state, story.country].filter(Boolean).join(', '),
    [story.state, story.country].filter(Boolean).join(', '),
  ].map((value) => String(value || '').trim()).filter(Boolean);
  for (const query of [...new Set(queryCandidates)]) {
    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`, {
        headers: { Accept: 'application/json' },
      });
      const data = await response.json();
      const match = Array.isArray(data) ? data[0] : null;
      if (!match) continue;
      const point = { lat: Number(match.lat), lng: Number(match.lon) };
      directoryState.geocodeCache.set(cacheKey, point);
      return point;
    } catch {}
  }
  return null;
}

function clearMapMarkers() {
  directoryState.markers.forEach((marker) => marker?.remove?.());
  directoryState.markers = [];
}

async function renderMapResults() {
  if (!directoryState.hasSearched) {
    mapListEl.innerHTML = '<div class="vendor-map-status">Run a search to display matching stories on the map.</div>';
    hideMapStoryPanel();
    const mapReady = await ensureMap();
    if (mapReady && directoryState.map) {
      clearMapMarkers();
      directoryState.map.setCenter?.(INDIA_CENTER);
      directoryState.map.setZoom?.(4.8);
    }
    return;
  }
  const pageResults = getPageResults();
  mapListEl.innerHTML = pageResults.length
    ? pageResults.map((story) => `<article class="vendor-map-list-item" data-focus-story="${esc(story.story_uid)}"><strong>${esc(story.title)}</strong><span>${esc(story.person_name || 'Unknown person')} | ${esc(story.place_label || 'Place not listed')}</span><div class="btn-group"><a class="btn btn-small" href="./product-detail.html?story=${encodeURIComponent(story.story_uid)}">View Details</a><a class="btn btn-warning btn-small" href="${esc(story.story_url || '#')}" target="_blank" rel="noreferrer">View on Better India</a></div></article>`).join('')
    : '<div class="vendor-map-placeholder">No map results for the current filter.</div>';
  Array.from(mapListEl.querySelectorAll('[data-focus-story]')).forEach((button) => {
    button.addEventListener('click', (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('a')) return;
      focusStory(button.dataset.focusStory, { scroll: true });
    });
  });
  setSelectedStory(directoryState.selectedStoryId);

  const mapReady = await ensureMap();
  if (!mapReady || !directoryState.map) return;
  clearMapMarkers();
  const bounds = [];
  let markerCount = 0;
  for (const story of pageResults) {
    const point = await geocodeStory(story);
    if (!point) continue;
    bounds.push([point.lat, point.lng]);
    const marker = new window.mappls.Marker({
      map: directoryState.map,
      position: point,
      html: DEFAULT_MARKER_HTML,
      width: 20,
      height: 20,
      fitbounds: false,
    });
    marker?.on?.('click', () => {
      setSelectedStory(story.story_uid);
      showMapStoryPanel(story);
      persistSearchState();
    });
    marker?.addListener?.('click', () => {
      setSelectedStory(story.story_uid);
      showMapStoryPanel(story);
      persistSearchState();
    });
    directoryState.markers.push(marker);
    markerCount += 1;
  }
  if (!markerCount && pageResults.length) {
    mapListEl.insertAdjacentHTML('afterbegin', '<div class="vendor-map-status">Stories are listed here, but no usable coordinates could be derived from the current page of results yet.</div>');
  }
  if (bounds.length && directoryState.map?.fitBounds) {
    directoryState.map.fitBounds(bounds, { padding: 60, maxZoom: 8 });
  } else if (directoryState.map?.setCenter) {
    directoryState.map.setCenter(INDIA_CENTER);
    directoryState.map.setZoom?.(4.8);
  }
}

async function initDirectory() {
  statusEl.textContent = 'Loading Better India stories from Supabase...';
  try {
    const { stories, people } = await window.BetterIndiaStore.loadStories();
    directoryState.stories = stories;
    directoryState.people = people;
    directoryState.filteredStories = [];
    directoryState.hasSearched = false;
    directoryState.currentPage = 1;
    directoryState.selectedStoryId = null;
    populateFilterOptions();
    const params = new URLSearchParams(window.location.search);
    const snapshot = restoreSearchState();
    if (shouldRestoreSnapshot(params) && snapshot?.hasSearched) {
      restoreSavedSearch(snapshot);
      statusEl.textContent = `${stories.length} Better India stor${stories.length === 1 ? 'y' : 'ies'} loaded from Supabase.`;
      return;
    }
    setCounts();
    renderResults();
    renderPagination();
    updateResultsSummary();
    renderMapResults();
    statusEl.textContent = `${stories.length} Better India stor${stories.length === 1 ? 'y' : 'ies'} loaded from Supabase.`;
  } catch (error) {
    statusEl.textContent = error.message || 'Better India stories could not be loaded.';
  }
}

document.getElementById('run-search').addEventListener('click', runSearch);
document.getElementById('clear-search').addEventListener('click', clearSearch);
Object.values(searchEls).forEach((input) => {
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runSearch();
    }
  });
});

initDirectory();
