const loginForm = document.getElementById('loginForm');
const loginStatus = document.getElementById('loginStatus');
const sessionStatus = document.getElementById('sessionStatus');
const sessionPanel = document.getElementById('sessionPanel');
const storySyncPanel = document.getElementById('storySyncPanel');
const storySyncMeta = document.getElementById('storySyncMeta');
const storySyncRuns = document.getElementById('storySyncRuns');
const runStorySyncButton = document.getElementById('runStorySync');
const signOutButton = document.getElementById('signOutButton');
const adminEditorPanel = document.getElementById('adminEditorPanel');
const adminSearchInput = document.getElementById('adminSearchInput');
const adminSearchMeta = document.getElementById('adminSearchMeta');
const adminSearchResults = document.getElementById('adminSearchResults');
const adminEditForm = document.getElementById('adminEditForm');
const adminEditorEmpty = document.getElementById('adminEditorEmpty');
const adminEditorFields = document.getElementById('adminEditorFields');
const adminEditStatus = document.getElementById('adminEditStatus');
const saveStoryButton = document.getElementById('saveStoryButton');

const ADMIN_SESSION_KEY = 'better-india-admin-session';
const adminState = {
  stories: [],
  filteredStories: [],
  selectedStoryId: '',
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

function renderStorySyncRuns(items) {
  storySyncRuns.innerHTML = '';
  if (!items.length) {
    storySyncRuns.innerHTML = '<article class="admin-card"><p>No Better India sync runs yet.</p></article>';
    return;
  }
  items.forEach((item) => {
    const card = document.createElement('article');
    card.className = 'admin-card';
    card.innerHTML = `<div class="admin-card-header"><h4>${escapeHtml(item.status || 'unknown')}</h4><span class="admin-badge ${item.status === 'success' ? 'approved' : ''}">${escapeHtml(item.status || 'unknown')}</span></div><p><strong>Requested By:</strong> ${escapeHtml(item.requested_by || 'Unknown')}</p><p><strong>Started:</strong> ${escapeHtml(formatDate(item.started_at || item.created_at))}</p><p><strong>Finished:</strong> ${escapeHtml(formatDate(item.finished_at))}</p><p><strong>Stories:</strong> ${escapeHtml(String(item.story_count || 0))}</p><p><strong>Error:</strong> ${escapeHtml(item.error_message || 'None')}</p></article>`;
    storySyncRuns.appendChild(card);
  });
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
    updateSessionUi(false);
    storySyncMeta.textContent = 'Your admin session has expired. Please sign in again.';
    adminSearchMeta.textContent = 'Your admin session has expired. Please sign in again.';
    return false;
  }
}

async function loadStorySyncRuns() {
  const token = getStoredToken();
  if (!token) {
    storySyncMeta.textContent = 'Sign in as admin to view and run sync operations.';
    storySyncRuns.innerHTML = '';
    return;
  }
  storySyncMeta.textContent = 'Loading Better India sync history...';
  try {
    const data = await window.BetterIndiaStore.adminRequest('listBetterIndiaSyncRuns', { token });
    const items = Array.isArray(data?.items) ? data.items : [];
    storySyncMeta.textContent = `${items.length} Better India sync run${items.length === 1 ? '' : 's'} recorded`;
    renderStorySyncRuns(items);
  } catch (error) {
    storySyncMeta.textContent = error.message || 'Better India sync history could not be loaded.';
  }
}

async function runStorySync() {
  runStorySyncButton.disabled = true;
  setStatus(sessionStatus, 'Running Better India story sync...');
  try {
    const data = await window.BetterIndiaStore.adminRequest('syncBetterIndiaStories', { token: getStoredToken() });
    setStatus(sessionStatus, `Better India sync completed: ${data.storyCount || 0} stories processed.`);
    await Promise.all([loadStorySyncRuns(), loadAdminStories()]);
  } catch (error) {
    setStatus(sessionStatus, error.message || 'Better India sync failed.', true);
  } finally {
    runStorySyncButton.disabled = false;
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
        six_m_categories: parseCommaList(editEls.sixMCategories.value),
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
    await Promise.all([loadStorySyncRuns(), loadAdminStories()]);
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
  updateSessionUi(false);
  storySyncMeta.textContent = 'Sign in as admin to view and run sync operations.';
  adminSearchMeta.textContent = 'Sign in as admin to search and edit stories.';
  storySyncRuns.innerHTML = '';
  adminSearchResults.innerHTML = '';
  setEditorVisible(false);
  setStatus(sessionStatus, '');
  setStatus(loginStatus, '');
  setStatus(adminEditStatus, '');
});

adminSearchInput.addEventListener('input', () => {
  filterAdminStories();
  renderAdminResults();
});
runStorySyncButton.addEventListener('click', runStorySync);
adminEditForm.addEventListener('submit', saveStoryEdits);

(async function initAdmin() {
  updateSessionUi(false);
  const valid = await verifySession();
  if (valid) {
    await Promise.all([loadStorySyncRuns(), loadAdminStories()]);
  }
})();

