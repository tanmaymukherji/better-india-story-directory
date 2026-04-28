function esc(value) {
  return String(value || '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
}

function renderChips(values, className = 'innovation-chip innovation-chip-muted') {
  const items = Array.isArray(values) ? values.filter(Boolean) : [];
  return items.length
    ? `<div class="innovation-chip-row">${items.map((item) => `<span class="${className}">${esc(item)}</span>`).join('')}</div>`
    : '<p>Not listed</p>';
}

async function initStoryDetail() {
  const params = new URLSearchParams(window.location.search);
  const storyId = params.get('story');
  const root = document.getElementById('product-detail-root');
  if (!storyId) {
    root.innerHTML = '<section class="section"><p>Story id is missing.</p></section>';
    return;
  }

  try {
    const { stories } = await window.BetterIndiaStore.loadStories();
    const story = stories.find((item) => item.story_uid === storyId);
    if (!story) {
      root.innerHTML = '<section class="section"><p>Story not found in the synced Supabase directory.</p></section>';
      return;
    }
    document.getElementById('detail-title').textContent = story.title || 'Story Detail';
    document.getElementById('detail-subtitle').textContent = `${story.person_name || 'Unknown person'} | ${story.place_label || 'Place not listed'}`;
    document.getElementById('back-to-person').href = `./vendor-detail.html?person=${encodeURIComponent(story.person_name || '')}`;

    root.innerHTML = `<section class="section"><div class="innovation-detail-hero">${story.cover_image_url ? `<img class="innovation-detail-image" src="${esc(story.cover_image_url)}" alt="${esc(story.title)}" referrerpolicy="no-referrer" />` : ''}<div class="innovation-detail-summary"><div class="vendor-result-top"><div><h3>${esc(story.title || 'Untitled story')}</h3><p>${esc(story.person_name || 'Unknown person')} | ${esc(story.place_label || 'Place not listed')}</p></div><span class="admin-badge approved">${esc(story.thematic_area || 'General')}</span></div><p>${esc(story.summary_of_work || story.story_excerpt || 'No saved summary available.')}</p><div><strong>6M Classification</strong>${renderChips(story.six_m_categories, 'innovation-chip')}</div><div><strong>Tags</strong>${renderChips(story.tags)}</div><div class="vendor-detail-grid"><div><h4>Contact Summary</h4><p><strong>Email:</strong> ${esc(story.contact_email || 'Not listed')}</p><p><strong>Phone:</strong> ${esc(story.contact_phone || 'Not listed')}</p><p><strong>Address:</strong> ${esc(story.contact_address || 'Not listed')}</p><p><strong>Published:</strong> ${esc(story.source_published_at ? new Date(story.source_published_at).toLocaleDateString('en-IN', { dateStyle: 'medium' }) : 'Not listed')}</p></div><div><h4>Source Links</h4><p><strong>Better India:</strong> ${story.story_url ? `<a href="${esc(story.story_url)}" target="_blank" rel="noreferrer">View on Better India</a>` : 'Not listed'}</p><p><strong>Person Detail:</strong> <a href="./vendor-detail.html?person=${encodeURIComponent(story.person_name || '')}">Open person profile</a></p><p><strong>Admin Notes:</strong> ${esc(story.admin_notes || 'Not listed')}</p></div></div></div></div></section>`;
  } catch (error) {
    root.innerHTML = `<section class="section"><p>${esc(error.message || 'Story detail could not be loaded.')}</p></section>`;
  }
}

initStoryDetail();

