const loginForm = document.getElementById('loginForm');
const loginStatus = document.getElementById('loginStatus');
const sessionStatus = document.getElementById('sessionStatus');
const sessionPanel = document.getElementById('sessionPanel');
const storySyncPanel = document.getElementById('storySyncPanel');
const storySyncMeta = document.getElementById('storySyncMeta');
const storySyncRuns = document.getElementById('storySyncRuns');
const runStorySyncButton = document.getElementById('runStorySync');
const signOutButton = document.getElementById('signOutButton');
const storySyncRunningIndicator = document.getElementById('storySyncRunningIndicator');
const storySyncRunningText = document.getElementById('storySyncRunningText');
const adminEditorPanel = document.getElementById('adminEditorPanel');
const adminSearchInput = document.getElementById('adminSearchInput');
const adminSearchMeta = document.getElementById('adminSearchMeta');
const adminSearchResults = document.getElementById('adminSearchResults');
const adminEditForm = document.getElementById('adminEditForm');
const adminEditorEmpty = document.getElementById('adminEditorEmpty');
const adminEditorFields = document.getElementById('adminEditorFields');
const adminEditStatus = document.getElementById('adminEditStatus');
const saveStoryButton = document.getElementById('saveStoryButton');
const sixMPreview = document.getElementById('sixMPreview');
const puterModelSelect = document.getElementById('puterModelSelect');
const refreshPuterModelsButton = document.getElementById('refreshPuterModels');
const puterRewriteSummaryButton = document.getElementById('puterRewriteSummary');
const puterSuggestMetadataButton = document.getElementById('puterSuggestMetadata');
const puterStatus = document.getElementById('puterStatus');

const ADMIN_SESSION_KEY = 'better-india-admin-session';
const SIX_M_OPTIONS = ['Manpower', 'Method', 'Material', 'Machine', 'Money', 'Market'];
const adminState = {
  stories: [],
  filteredStories: [],
  selectedStoryId: '',
  syncPollTimer: null,
  syncPendingRefresh: false,
  syncQueuedAt: 0,
  puterModelsLoaded: false,
  puterModels: [],
};

const editEls = {
  storyId: document.getElementById('editStoryId'),
  storyTitle: document.getElementById('editStoryTitle'),
  personName: document.getElementById('editPersonName'),
  thematicArea: document.getElementById('editThematicArea'),
  placeLabel: document.getElementById('editPlaceLabel'),
  contactEmail: document.getElementById('editContactEmail'),
  contactPhone: document.getElementById('editContactPhone'),
  contactAddress: document.getElementById('editContactAddress'),
  sixMCategories: document.getElementById('editSixMCategories'),
  tags: document.getElementById('editTags'),
  storySummary: document.getElementById('editStorySummary'),
  sourceUrl: document.getElementById('editSourceUrl'),
  latitude: document.getElementById('editLatitude'),
  longitude: document.getElementById('editLongitude'),
  adminNotes: document.getElementById('editAdminNotes'),
};

function setStatus(element, message, isError = false) {
  element.textContent = message || '';
  element.classList.toggle('error', Boolean(isError));
}

function setPuterStatus(message, isError = false) {
  if (!puterStatus) return;
  setStatus(puterStatus, message, isError);
}

function escapeHtml(value) {
  return String(value || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function formatDate(value) {
  if (!value) return 'Unknown date';
  return new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

function parseCommaList(value) {
  return [...new Set(String(value || '').split(',').map((item) => item.trim()).filter(Boolean))];
}

function normalizeSixMValues(value) {
  const normalizedMap = new Map(SIX_M_OPTIONS.map((item) => [item.toLowerCase(), item]));
  return parseCommaList(value)
    .map((item) => normalizedMap.get(String(item || '').trim().toLowerCase()) || '')
    .filter(Boolean);
}

function renderSixMPreview(value) {
  if (!sixMPreview) return;
  const items = normalizeSixMValues(value);
  sixMPreview.innerHTML = items.length
    ? items.map((item) => `<span class="innovation-chip">${escapeHtml(item)}</span>`).join('')
    : '<span class="innovation-chip innovation-chip-muted">No valid 6M categories selected</span>';
}

function extractPuterText(response) {
  if (typeof response === 'string') return response.trim();
  const direct = String(
    response?.message?.content ||
    response?.content ||
    response?.text ||
    response?.result ||
    ''
  ).trim();
  if (direct) return direct;
  return JSON.stringify(response || {});
}

function stripCodeFences(value) {
  return String(value || '').replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
}

function parseJsonObject(text) {
  const cleaned = stripCodeFences(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AI response did not contain valid JSON.');
    return JSON.parse(match[0]);
  }
}

function parseJsonObjectOrNull(text) {
  try {
    return parseJsonObject(text);
  } catch {
    return null;
  }
}

function uniqueList(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function normalizePuterModelEntries(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      if (typeof item === 'string') return { id: item, name: item };
      const id = String(item?.id || item?.model || item?.name || '').trim();
      const name = String(item?.name || item?.label || item?.id || id).trim();
      return id ? { id, name } : null;
    })
    .filter(Boolean);
}

function getSelectedStory() {
  return adminState.stories.find((item) => item.story_uid === adminState.selectedStoryId) || null;
}

function getChosenPuterModel() {
  return String(puterModelSelect?.value || '').trim() || null;
}

function buildPuterContext(story) {
  return {
    story_uid: story.story_uid,
    title: story.title || null,
    person_name: story.person_name || null,
    thematic_area: story.thematic_area || null,
    place_label: story.place_label || null,
    contact_email: story.contact_email || null,
    contact_phone: story.contact_phone || null,
    contact_address: story.contact_address || null,
    six_m_categories: story.six_m_categories || [],
    tags: story.tags || [],
    summary_of_work: story.summary_of_work || null,
    story_excerpt: story.story_excerpt || null,
    story_url: story.story_url || null,
    admin_notes: story.admin_notes || null,
    ai_summary: story.ai_summary || null,
    raw_story: story.raw_story || null,
  };
}

async function ensurePuterModelsLoaded(forceRefresh = false) {
  if (!window.puter?.ai) {
    throw new Error('Puter AI is not available on this page.');
  }
  if (adminState.puterModelsLoaded && !forceRefresh) return adminState.puterModels;
  setPuterStatus('Loading Puter models...');
  const result = await window.puter.ai.listModels();
  const models = normalizePuterModelEntries(result);
  adminState.puterModels = models;
  adminState.puterModelsLoaded = true;
  if (puterModelSelect) {
    const previous = getChosenPuterModel();
    puterModelSelect.innerHTML = '<option value="">Default Puter model</option>';
    models.slice(0, 200).forEach((model) => {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.name;
      puterModelSelect.appendChild(option);
    });
    if (previous && models.some((model) => model.id === previous)) {
      puterModelSelect.value = previous;
    }
  }
  setPuterStatus(models.length ? `Loaded ${models.length} Puter model options.` : 'No Puter models were returned.');
  return models;
}

async function runPuterChat(prompt) {
  await ensurePuterModelsLoaded(false);
  const model = getChosenPuterModel();
  const options = model ? { model } : {};
  const response = await window.puter.ai.chat(prompt, options);
  return extractPuterText(response);
}

function applyPuterMetadata(payload) {
  if (payload.person_name) editEls.personName.value = String(payload.person_name).trim();
  if (payload.thematic_area) editEls.thematicArea.value = String(payload.thematic_area).trim();
  if (payload.place_label) editEls.placeLabel.value = String(payload.place_label).trim();
  if (payload.contact_email) editEls.contactEmail.value = String(payload.contact_email).trim();
  if (payload.contact_phone) editEls.contactPhone.value = String(payload.contact_phone).trim();
  if (payload.contact_address) editEls.contactAddress.value = String(payload.contact_address).trim();
  if (payload.summary_of_work) editEls.storySummary.value = String(payload.summary_of_work).trim();
  if (Array.isArray(payload.tags)) editEls.tags.value = uniqueList(payload.tags).join(', ');
  if (Array.isArray(payload.six_m_categories)) {
    editEls.sixMCategories.value = normalizeSixMValues((payload.six_m_categories || []).join(', ')).join(', ');
    renderSixMPreview(editEls.sixMCategories.value);
  }
}

function getStoredToken() {
  return window.sessionStorage.getItem(ADMIN_SESSION_KEY) || '';
}

function storeToken(token) {
  if (token) window.sessionStorage.setItem(ADMIN_SESSION_KEY, token);
  else window.sessionStorage.removeItem(ADMIN_SESSION_KEY);
}

function updateSessionUi(isSignedIn) {
  loginForm.style.display = isSignedIn ? 'none' : 'grid';
  sessionPanel.classList.toggle('active', Boolean(isSignedIn));
  storySyncPanel.classList.toggle('active', Boolean(isSignedIn));
  adminEditorPanel.classList.toggle('active', Boolean(isSignedIn));
}

function clearSyncPollTimer() {
  if (adminState.syncPollTimer) {
    window.clearTimeout(adminState.syncPollTimer);
    adminState.syncPollTimer = null;
  }
}

function setRunningIndicator(isRunning, message = '') {
  if (!storySyncRunningIndicator || !storySyncRunningText) return;
  storySyncRunningIndicator.hidden = !isRunning;
  storySyncRunningText.textContent = message || 'Better India sync is running. The screen will refresh automatically when it completes.';
}

function scheduleSyncStatusPoll(delay = 15000) {
  clearSyncPollTimer();
  if (!getStoredToken()) return;
  adminState.syncPollTimer = window.setTimeout(() => {
    refreshSyncMonitor().catch(() => {});
  }, delay);
}

function renderStorySyncRuns(items) {
  storySyncRuns.innerHTML = '';
  if (!items.length) {
    storySyncRuns.innerHTML = '<article class="admin-card"><p>No Better India sync runs yet.</p></article>';
    return { hasRunning: false, latestFinished: null };
  }
  let hasRunning = false;
  let latestFinished = null;
  items.forEach((item) => {
    if (item.status === 'running') hasRunning = true;
    if (!latestFinished && item.finished_at) latestFinished = item.finished_at;
    const card = document.createElement('article');
    card.className = 'admin-card';
    card.innerHTML = `<div class="admin-card-header"><h4>${escapeHtml(item.status || 'unknown')}</h4><span class="admin-badge ${item.status === 'success' ? 'approved' : ''}">${escapeHtml(item.status || 'unknown')}</span></div><p><strong>Requested By:</strong> ${escapeHtml(item.requested_by || 'Unknown')}</p><p><strong>Started:</strong> ${escapeHtml(formatDate(item.started_at || item.created_at))}</p><p><strong>Finished:</strong> ${escapeHtml(formatDate(item.finished_at))}</p><p><strong>Stories:</strong> ${escapeHtml(String(item.story_count || 0))}</p><p><strong>Error:</strong> ${escapeHtml(item.error_message || 'None')}</p><div class="btn-group"><button class="btn btn-danger btn-small" type="button" data-delete-sync-run="${escapeHtml(item.id || '')}">Delete Log</button></div></article>`;
    card.querySelector('[data-delete-sync-run]')?.addEventListener('click', () => deleteStorySyncRun(item.id));
    storySyncRuns.appendChild(card);
  });
  return { hasRunning, latestFinished };
}

function buildStorySearchText(story) {
  return [
    story.title,
    story.person_name,
    story.thematic_area,
    story.place_label,
    story.summary_of_work,
    story.contact_email,
    story.contact_phone,
    story.contact_address,
    story.story_excerpt,
    story.admin_notes,
    (story.tags || []).join(' '),
    (story.six_m_categories || []).join(' '),
  ].join(' ').toLowerCase();
}

function filterAdminStories() {
  const query = String(adminSearchInput.value || '').trim().toLowerCase();
  const stories = [...adminState.stories].sort((left, right) => String(right.source_published_at || '').localeCompare(String(left.source_published_at || '')) || String(left.title || '').localeCompare(String(right.title || '')));
  adminState.filteredStories = !query
    ? stories
    : stories.filter((story) => buildStorySearchText(story).includes(query));
}

function renderAdminResults() {
  adminSearchResults.innerHTML = '';
  if (!adminState.filteredStories.length) {
    adminSearchResults.innerHTML = '<article class="admin-card"><p>No story records matched this search.</p></article>';
    adminSearchMeta.textContent = 'No matching story records found.';
    return;
  }

  adminSearchMeta.textContent = `${adminState.filteredStories.length} story record${adminState.filteredStories.length === 1 ? '' : 's'} found`;
  adminState.filteredStories.forEach((story) => {
    const card = document.createElement('article');
    card.className = `admin-card admin-search-card${story.story_uid === adminState.selectedStoryId ? ' active' : ''}`;
    card.innerHTML = `<div class="admin-card-header"><h4>${escapeHtml(story.title || 'Untitled story')}</h4><span class="admin-badge approved">${escapeHtml(story.thematic_area || 'General')}</span></div><p><strong>Name:</strong> ${escapeHtml(story.person_name || 'Unknown person')}</p><p><strong>Place:</strong> ${escapeHtml(story.place_label || 'Not listed')}</p><p><strong>Contact:</strong> ${escapeHtml(story.contact_email || 'No email')} | ${escapeHtml(story.contact_phone || 'No phone')}</p><small>${escapeHtml(story.summary_of_work || story.story_excerpt || 'No summary saved')}</small>`;
    card.addEventListener('click', () => selectStory(story.story_uid));
    adminSearchResults.appendChild(card);
  });
}

function setEditorVisible(isVisible) {
  adminEditorEmpty.style.display = isVisible ? 'none' : 'block';
  adminEditorFields.classList.toggle('active', Boolean(isVisible));
}

function fillEditor(story) {
  editEls.storyId.value = story.story_uid || '';
  editEls.storyTitle.value = story.title || '';
  editEls.personName.value = story.person_name || '';
  editEls.thematicArea.value = story.thematic_area || '';
  editEls.placeLabel.value = story.place_label || '';
  editEls.contactEmail.value = story.contact_email || '';
  editEls.contactPhone.value = story.contact_phone || '';
  editEls.contactAddress.value = story.contact_address || '';
  editEls.sixMCategories.value = (story.six_m_categories || []).join(', ');
  editEls.tags.value = (story.tags || []).join(', ');
  editEls.storySummary.value = story.summary_of_work || '';
  editEls.sourceUrl.value = story.story_url || '';
  editEls.latitude.value = story.latitude ?? '';
  editEls.longitude.value = story.longitude ?? '';
  editEls.adminNotes.value = story.admin_notes || '';
  renderSixMPreview(editEls.sixMCategories.value);
  setPuterStatus('Puter AI assist is ready for this story.');
  setEditorVisible(true);
}

function selectStory(storyId) {
  adminState.selectedStoryId = storyId;
  const story = adminState.stories.find((item) => item.story_uid === storyId);
  if (!story) {
    setEditorVisible(false);
    return;
  }
  fillEditor(story);
  renderAdminResults();
  setStatus(adminEditStatus, '');
}

async function loadAdminStories() {
  if (!getStoredToken()) return;
  adminSearchMeta.textContent = 'Loading story records...';
  try {
    const { stories } = await window.BetterIndiaStore.loadAdminData();
    adminState.stories = Array.isArray(stories) ? stories : [];
    filterAdminStories();
    renderAdminResults();
    if (adminState.selectedStoryId && adminState.stories.some((item) => item.story_uid === adminState.selectedStoryId)) {
      selectStory(adminState.selectedStoryId);
    } else {
      adminState.selectedStoryId = '';
      setEditorVisible(false);
    }
  } catch (error) {
    adminSearchMeta.textContent = error.message || 'Story records could not be loaded.';
    adminSearchResults.innerHTML = '';
  }
}

async function verifySession() {
  const token = getStoredToken();
  if (!token) {
    updateSessionUi(false);
    return false;
  }
  try {
    const data = await window.BetterIndiaStore.adminRequest('verify', { token });
    if (!data?.valid) throw new Error('Session invalid');
    updateSessionUi(true);
    return true;
  } catch {
    storeToken('');
    clearSyncPollTimer();
    setRunningIndicator(false);
    updateSessionUi(false);
    storySyncMeta.textContent = 'Your admin session has expired. Please sign in again.';
    adminSearchMeta.textContent = 'Your admin session has expired. Please sign in again.';
    return false;
  }
}

async function loadStorySyncRuns() {
  const token = getStoredToken();
  if (!token) {
    clearSyncPollTimer();
    setRunningIndicator(false);
    storySyncMeta.textContent = 'Sign in as admin to view and run sync operations.';
    storySyncRuns.innerHTML = '';
    return { hasRunning: false, latestFinished: null, items: [] };
  }
  storySyncMeta.textContent = 'Loading Better India sync history...';
  try {
    const data = await window.BetterIndiaStore.adminRequest('listBetterIndiaSyncRuns', { token });
    const items = Array.isArray(data?.items) ? data.items : [];
    storySyncMeta.textContent = `${items.length} Better India sync run${items.length === 1 ? '' : 's'} recorded`;
    const state = renderStorySyncRuns(items);
    return { ...state, items };
  } catch (error) {
    setRunningIndicator(false);
    storySyncMeta.textContent = error.message || 'Better India sync history could not be loaded.';
    return { hasRunning: false, latestFinished: null, items: [] };
  }
}

async function refreshSyncMonitor() {
  const state = await loadStorySyncRuns();
  const queuedRecently = adminState.syncQueuedAt && (Date.now() - adminState.syncQueuedAt < 3 * 60 * 1000);
  const shouldShowRunning = state.hasRunning || (adminState.syncPendingRefresh && queuedRecently);
  if (shouldShowRunning) {
    const message = state.hasRunning
      ? 'Better India sync is running. This screen will refresh automatically when it completes.'
      : 'Better India sync was just queued. Waiting for the new run to appear...';
    setRunningIndicator(true, message);
    scheduleSyncStatusPoll(15000);
    return;
  }
  clearSyncPollTimer();
  setRunningIndicator(false);
  if (adminState.syncPendingRefresh) {
    adminState.syncPendingRefresh = false;
    adminState.syncQueuedAt = 0;
    setStatus(sessionStatus, 'Better India sync completed. Refreshing saved stories...');
    await Promise.all([loadAdminStories(), loadStorySyncRuns()]);
    setStatus(sessionStatus, 'Better India sync completed. The screen refreshed automatically.');
  }
}

async function runStorySync() {
  runStorySyncButton.disabled = true;
  setStatus(sessionStatus, 'Queueing Better India story sync...');
  try {
    const data = await window.BetterIndiaStore.adminRequest('syncBetterIndiaStories', { token: getStoredToken() });
    adminState.syncPendingRefresh = true;
    adminState.syncQueuedAt = Date.now();
    setRunningIndicator(true, 'Better India sync was queued. Waiting for the run to start...');
    setStatus(sessionStatus, data.message || 'Better India sync queued in GitHub Actions.');
    await refreshSyncMonitor();
  } catch (error) {
    adminState.syncPendingRefresh = false;
    adminState.syncQueuedAt = 0;
    setRunningIndicator(false);
    setStatus(sessionStatus, error.message || 'Better India sync could not be queued.', true);
  } finally {
    runStorySyncButton.disabled = false;
  }
}

async function deleteStorySyncRun(runId) {
  const token = getStoredToken();
  if (!token || !runId) {
    setStatus(sessionStatus, 'Sign in as admin first.', true);
    return;
  }
  setStatus(sessionStatus, 'Deleting Better India sync log...');
  try {
    const data = await window.BetterIndiaStore.adminRequest('deleteBetterIndiaSyncRun', { token, runId });
    setStatus(sessionStatus, data.message || 'Better India sync log deleted.');
    await loadStorySyncRuns();
  } catch (error) {
    setStatus(sessionStatus, error.message || 'Better India sync log could not be deleted.', true);
  }
}

async function saveStoryEdits(event) {
  event.preventDefault();
  const token = getStoredToken();
  const storyUid = String(editEls.storyId.value || '').trim();
  if (!token || !storyUid) {
    setStatus(adminEditStatus, 'Select a story record first.', true);
    return;
  }

  saveStoryButton.disabled = true;
  setStatus(adminEditStatus, 'Saving changes...');
  try {
    const payload = {
      token,
      storyUid,
      updates: {
        title: editEls.storyTitle.value,
        person_name: editEls.personName.value,
        thematic_area: editEls.thematicArea.value,
        place_label: editEls.placeLabel.value,
        contact_email: editEls.contactEmail.value,
        contact_phone: editEls.contactPhone.value,
        contact_address: editEls.contactAddress.value,
        six_m_categories: normalizeSixMValues(editEls.sixMCategories.value),
        tags: parseCommaList(editEls.tags.value),
        summary_of_work: editEls.storySummary.value,
        story_url: editEls.sourceUrl.value,
        latitude: editEls.latitude.value,
        longitude: editEls.longitude.value,
        admin_notes: editEls.adminNotes.value,
      },
    };
    await window.BetterIndiaStore.adminRequest('updateBetterIndiaStory', payload);
    setStatus(adminEditStatus, 'Story record updated.');
    await loadAdminStories();
    selectStory(storyUid);
  } catch (error) {
    setStatus(adminEditStatus, error.message || 'Story update failed.', true);
  } finally {
    saveStoryButton.disabled = false;
  }
}

async function rewriteSummaryWithPuter() {
  const story = getSelectedStory();
  if (!story) {
    setPuterStatus('Select a story record first.', true);
    return;
  }
  puterRewriteSummaryButton.disabled = true;
  setPuterStatus('Asking Puter to rewrite the summary...');
  try {
    const prompt = [
      'Rewrite the Better India story summary for an admin editor.',
      'Prefer returning strict JSON only with this schema:',
      '{"summary_of_work":string}',
      'If you cannot return JSON, return only the rewritten summary text with no introduction.',
      'Requirements:',
      '- Make the summary useful and specific, not generic.',
      '- Mention concrete actions, outcomes, and named contributors where relevant.',
      '- If the story describes a process, include the essential steps in prose.',
      '- Keep it concise enough for an admin summary field.',
      `Current record:\n${JSON.stringify(buildPuterContext(story))}`,
    ].join('\n');
    const text = await runPuterChat(prompt);
    const payload = parseJsonObjectOrNull(text);
    const rewritten = String(payload?.summary_of_work || text || '').trim();
    if (!rewritten) throw new Error('Puter did not return a rewritten summary.');
    editEls.storySummary.value = rewritten;
    setPuterStatus('Summary updated from Puter AI. Review and save when ready.');
  } catch (error) {
    setPuterStatus(error.message || 'Puter summary rewrite failed.', true);
  } finally {
    puterRewriteSummaryButton.disabled = false;
  }
}

async function suggestMetadataWithPuter() {
  const story = getSelectedStory();
  if (!story) {
    setPuterStatus('Select a story record first.', true);
    return;
  }
  puterSuggestMetadataButton.disabled = true;
  setPuterStatus('Asking Puter to suggest metadata...');
  try {
    const prompt = [
      'Improve this Better India story record for an admin editor.',
      'Return strict JSON only with this schema:',
      '{"person_name":string|null,"thematic_area":string|null,"place_label":string|null,"contact_email":string|null,"contact_phone":string|null,"contact_address":string|null,"six_m_categories":string[],"tags":string[],"summary_of_work":string|null}',
      'Rules:',
      '- six_m_categories must only use: Manpower, Method, Material, Machine, Money, Market.',
      '- Use the strict 6M meanings already present in the record.',
      '- Only suggest contact details if the context strongly supports them.',
      '- Tags should be short and admin-friendly.',
      '- If a field should stay unchanged, you may repeat the current value.',
      `Current record:\n${JSON.stringify(buildPuterContext(story))}`,
    ].join('\n');
    const text = await runPuterChat(prompt);
    const payload = parseJsonObjectOrNull(text);
    if (!payload) throw new Error('Puter returned free text instead of structured metadata JSON. Try another Puter model.');
    applyPuterMetadata(payload || {});
    setPuterStatus('Metadata suggestions applied from Puter AI. Review and save when ready.');
  } catch (error) {
    setPuterStatus(error.message || 'Puter metadata assist failed.', true);
  } finally {
    puterSuggestMetadataButton.disabled = false;
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = String(document.getElementById('adminPassword').value || '').trim();
  if (!password) {
    setStatus(loginStatus, 'Enter the admin password.', true);
    return;
  }
  setStatus(loginStatus, 'Signing in...');
  try {
    const data = await window.BetterIndiaStore.adminRequest('login', { password });
    if (!data?.token) throw new Error('Admin login failed.');
    storeToken(data.token);
    document.getElementById('adminPassword').value = '';
    updateSessionUi(true);
    setStatus(loginStatus, 'Signed in successfully.');
    await Promise.all([refreshSyncMonitor(), loadAdminStories()]);
  } catch (error) {
    setStatus(loginStatus, error.message || 'Admin login failed.', true);
  }
});

signOutButton.addEventListener('click', async () => {
  const token = getStoredToken();
  try {
    if (token) await window.BetterIndiaStore.adminRequest('logout', { token });
  } catch {}
  storeToken('');
  adminState.stories = [];
  adminState.filteredStories = [];
  adminState.selectedStoryId = '';
  adminState.syncPendingRefresh = false;
  adminState.syncQueuedAt = 0;
  clearSyncPollTimer();
  updateSessionUi(false);
  storySyncMeta.textContent = 'Sign in as admin to view and run sync operations.';
  adminSearchMeta.textContent = 'Sign in as admin to search and edit stories.';
  storySyncRuns.innerHTML = '';
  adminSearchResults.innerHTML = '';
  setEditorVisible(false);
  setRunningIndicator(false);
  setStatus(sessionStatus, '');
  setStatus(loginStatus, '');
  setStatus(adminEditStatus, '');
});

adminSearchInput.addEventListener('input', () => {
  filterAdminStories();
  renderAdminResults();
});
editEls.sixMCategories.addEventListener('input', () => {
  renderSixMPreview(editEls.sixMCategories.value);
});
refreshPuterModelsButton?.addEventListener('click', async () => {
  refreshPuterModelsButton.disabled = true;
  try {
    await ensurePuterModelsLoaded(true);
  } catch (error) {
    setPuterStatus(error.message || 'Puter models could not be loaded.', true);
  } finally {
    refreshPuterModelsButton.disabled = false;
  }
});
puterRewriteSummaryButton?.addEventListener('click', rewriteSummaryWithPuter);
puterSuggestMetadataButton?.addEventListener('click', suggestMetadataWithPuter);
runStorySyncButton.addEventListener('click', runStorySync);
adminEditForm.addEventListener('submit', saveStoryEdits);

(async function initAdmin() {
  updateSessionUi(false);
  if (window.puter?.ai) {
    setPuterStatus('Puter AI assist is available. Select a story, then load models or use the default model.');
  } else {
    setPuterStatus('Puter AI did not load on this page.', true);
  }
  const valid = await verifySession();
  if (valid) {
    await Promise.all([refreshSyncMonitor(), loadAdminStories()]);
  }
})();
