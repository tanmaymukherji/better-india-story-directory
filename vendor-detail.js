function esc(value) {
  return String(value || '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
}

async function initPersonDetail() {
  const params = new URLSearchParams(window.location.search);
  const personName = params.get('person');
  const root = document.getElementById('vendor-detail-root');
  if (!personName) {
    root.innerHTML = '<section class="section"><p>Person name is missing.</p></section>';
    return;
  }

  try {
    const { stories, people } = await window.BetterIndiaStore.loadStories();
    const person = people.find((item) => String(item.person_name || '').toLowerCase() === String(personName || '').toLowerCase());
    if (!person) {
      root.innerHTML = '<section class="section"><p>Person not found in the synced Supabase directory.</p></section>';
      return;
    }
    const relatedStories = stories.filter((item) => String(item.person_name || '').toLowerCase() === String(person.person_name || '').toLowerCase());
    document.getElementById('detail-title').textContent = person.person_name;
    document.getElementById('detail-subtitle').textContent = person.place_label || 'Place not listed';
    root.innerHTML = `<section class="section"><div class="vendor-result-top"><div><h3>${esc(person.person_name)}</h3><p>${esc(person.place_label || 'Place not listed')}</p></div><span class="admin-badge approved">${esc(String(relatedStories.length))} stor${relatedStories.length === 1 ? 'y' : 'ies'}</span></div><div class="vendor-detail-grid"><div><h4>Contact</h4><p><strong>Email:</strong> ${esc(person.contact_email || 'Not listed')}</p><p><strong>Phone:</strong> ${esc(person.contact_phone || 'Not listed')}</p><p><strong>Address:</strong> ${esc(person.contact_address || 'Not listed')}</p></div><div><h4>Directory Meta</h4><p><strong>Thematic Areas:</strong> ${esc((person.thematic_areas || []).join(', ') || 'Not listed')}</p><p><strong>Tags:</strong> ${esc((person.tags || []).join(', ') || 'Not listed')}</p><p><strong>6M:</strong> ${esc((person.six_m_categories || []).join(', ') || 'Not listed')}</p></div></div></section><section class="section"><h3>Stories</h3><div class="vendor-products-grid">${relatedStories.length ? relatedStories.map((story) => `<article class="vendor-product-card"><div class="vendor-product-media">${story.cover_image_url ? `<img class="vendor-product-image" src="${esc(story.cover_image_url)}" alt="${esc(story.title)}" loading="lazy" referrerpolicy="no-referrer" />` : ''}<div><h4>${esc(story.title)}</h4><p>${esc(story.summary_of_work || story.story_excerpt || 'No summary available.')}</p><p><strong>Thematic:</strong> ${esc(story.thematic_area || 'General')}</p><p><strong>Place:</strong> ${esc(story.place_label || 'Not listed')}</p><p><strong>Tags:</strong> ${esc((story.tags || []).join(', ') || 'Not listed')}</p></div></div><div class="btn-group"><a class="btn btn-small" href="./product-detail.html?story=${encodeURIComponent(story.story_uid)}">View Details</a><a class="btn btn-warning btn-small" href="${esc(story.story_url || '#')}" target="_blank" rel="noreferrer">View on Better India</a></div></article>`).join('') : '<p>No stories were synced for this person.</p>'}</div></section>`;
  } catch (error) {
    root.innerHTML = `<section class="section"><p>${esc(error.message || 'Person detail could not be loaded.')}</p></section>`;
  }
}

initPersonDetail();
