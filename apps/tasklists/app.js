const elements = {
  collectionList: document.getElementById('collection-list'),
  listList: document.getElementById('list-list'),
  contextTitle: document.getElementById('context-title'),
  assignShortcut: document.getElementById('assign-shortcut'),
  deleteCollection: document.getElementById('delete-collection'),
  addItem: document.getElementById('add-item'),
  listTools: document.getElementById('list-tools'),
  itemList: document.getElementById('item-list'),
  collectionMembership: document.getElementById('collection-membership'),
  searchButton: document.getElementById('search-button'),
  searchOverlay: document.getElementById('search-overlay'),
  searchInput: document.getElementById('search-input'),
  searchResults: document.getElementById('search-results'),
  searchScope: document.getElementById('search-scope'),
  moveOverlay: document.getElementById('move-overlay'),
  moveInput: document.getElementById('move-input'),
  moveResults: document.getElementById('move-results'),
  itemTemplate: document.getElementById('item-template'),
  app: document.getElementById('app'),
};

const state = {
  lists: new Map(),
  items: new Map(),
  collections: new Map(),
  selected: null,
  activeItemId: null,
  shortcutCapture: null,
};

let idCounter = 0;
const createId = (prefix) => `${prefix}-${++idCounter}`;

function seedData() {
  const inbox = createList('Product Experiments');
  const userResearch = createList('User Research Notes');
  const backlog = createList('Backlog Refinement');

  createItem(inbox.id, 'Polish onboarding #flow for @newcomers', 'Revisit the tooltip cues and consider a short looping video.');
  createItem(inbox.id, 'Draft experiment brief for #pricing adjustments', 'Need baseline metrics. Ping @finance.');
  createItem(inbox.id, 'Outline talk track for @sales enablement', 'Keep it under 5 min, focus on key objections.');

  createItem(userResearch.id, 'Synthesis: #mobile usability tests', 'Recurring friction around gesture discoverability.');
  createItem(userResearch.id, 'Interview recap @martha', 'Anchors on feeling in control. Loves drag speeds when predictable.');
  createItem(userResearch.id, 'Cluster findings for #persona updates', 'Split into primary / secondary. Look at motivations.');

  createItem(backlog.id, 'Ready: Contextual quick-move palette', 'Keyboard-first flow. Should read from the same list source as command bar.');
  createItem(backlog.id, 'Next: Touch-friendly reorder handles', 'Test on iPad + Procreate style magnetism.');
  createItem(backlog.id, 'Later: Smart suggestions for @handoff tasks', 'Maybe start shallow with recents.');

  createCollection('Daily Focus', [inbox.id, userResearch.id]);
  createCollection('Roadmap Draft', [backlog.id, inbox.id]);
  createCollection('Research Pack', [userResearch.id]);

  // Assign a default shortcut for demo.
  inbox.shortcut = { key: '1', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false };
}

function createList(name) {
  const list = {
    id: createId('list'),
    name,
    itemIds: [],
    shortcut: null,
  };
  state.lists.set(list.id, list);
  return list;
}

function createItem(listId, title, payload) {
  const item = {
    id: createId('item'),
    listId,
    title,
    payload,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.items.set(item.id, item);
  const list = state.lists.get(listId);
  if (list) {
    list.itemIds.push(item.id);
  }
  return item;
}

function createCollection(name, listIds = []) {
  const collection = {
    id: createId('collection'),
    name,
    listIds: [...new Set(listIds)],
  };
  state.collections.set(collection.id, collection);
  return collection;
}

function deleteItem(itemId) {
  const item = state.items.get(itemId);
  if (!item) return;
  const list = state.lists.get(item.listId);
  if (list) {
    list.itemIds = list.itemIds.filter((id) => id !== itemId);
  }
  state.items.delete(itemId);
  if (state.activeItemId === itemId) {
    state.activeItemId = null;
  }
  renderMain();
  renderSidebarLists();
}

function deleteCollection(collectionId) {
  state.collections.delete(collectionId);
  if (state.selected?.type === 'collection' && state.selected.id === collectionId) {
    const fallback = state.lists.values().next().value;
    if (fallback) {
      selectContext('list', fallback.id);
    } else {
      state.selected = null;
      renderMain();
    }
  }
  renderSidebarCollections();
}

function selectContext(type, id) {
  state.selected = { type, id };
  if (type === 'list') {
    const list = state.lists.get(id);
    if (list && !list.itemIds.includes(state.activeItemId)) {
      state.activeItemId = list.itemIds[0] ?? null;
    }
  }
  renderSidebarLists();
  renderSidebarCollections();
  renderMain();
}

function renderSidebarLists() {
  const container = elements.listList;
  container.innerHTML = '';
  const fragment = document.createDocumentFragment();
  [...state.lists.values()].forEach((list) => {
    const btn = document.createElement('button');
    btn.className = 'nav-button';
    btn.dataset.selected = state.selected?.type === 'list' && state.selected.id === list.id ? 'true' : 'false';
    btn.dataset.id = list.id;
    btn.innerHTML = `
      <span>${escapeHtml(list.name)}</span>
      <span class="badge">${list.itemIds.length}</span>
      ${list.shortcut ? `<span class="badge-key">${formatShortcut(list.shortcut)}</span>` : ''}
    `;
    btn.addEventListener('click', () => selectContext('list', list.id));
    fragment.appendChild(btn);
  });
  container.appendChild(fragment);
}

function renderSidebarCollections() {
  const container = elements.collectionList;
  container.innerHTML = '';
  const fragment = document.createDocumentFragment();
  [...state.collections.values()].forEach((collection) => {
    const btn = document.createElement('button');
    btn.className = 'nav-button';
    btn.dataset.selected = state.selected?.type === 'collection' && state.selected.id === collection.id ? 'true' : 'false';
    btn.dataset.id = collection.id;
    btn.innerHTML = `
      <span>${escapeHtml(collection.name)}</span>
      <span class="badge">${collection.listIds.length}</span>
    `;
    btn.addEventListener('click', () => selectContext('collection', collection.id));
    fragment.appendChild(btn);
  });
  container.appendChild(fragment);
}

function renderMain() {
  if (!state.selected) {
    elements.contextTitle.textContent = 'Select a list';
    elements.assignShortcut.hidden = true;
    elements.addItem.disabled = true;
    elements.itemList.innerHTML = '';
    elements.deleteCollection.hidden = true;
    elements.collectionMembership.hidden = true;
    return;
  }

  if (state.selected.type === 'list') {
    const list = state.lists.get(state.selected.id);
    if (!list) return;
    renderListView(list);
  } else if (state.selected.type === 'collection') {
    const collection = state.collections.get(state.selected.id);
    if (!collection) return;
    renderCollectionView(collection);
  }
}

function renderListView(list) {
  if (!list.itemIds.includes(state.activeItemId)) {
    state.activeItemId = list.itemIds[0] ?? null;
  }
  elements.contextTitle.textContent = list.name;
  elements.contextTitle.dataset.type = 'list';
  elements.contextTitle.dataset.id = list.id;
  elements.assignShortcut.hidden = false;
  elements.assignShortcut.textContent = list.shortcut ? formatShortcut(list.shortcut) : 'Set Shortcut';
  elements.assignShortcut.dataset.listId = list.id;
  elements.deleteCollection.hidden = true;
  elements.collectionMembership.hidden = true;
  elements.addItem.disabled = false;
  elements.addItem.hidden = false;
  elements.itemList.classList.remove('collection-mode');

  const listEl = elements.itemList;
  listEl.innerHTML = '';
  const fragment = document.createDocumentFragment();
  list.itemIds.forEach((itemId) => {
    const item = state.items.get(itemId);
    if (!item) return;
    const node = elements.itemTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = item.id;
    node.dataset.listId = list.id;

    const titleEl = node.querySelector('.item-title');
    renderItemTitle(titleEl, item.title);
    titleEl.addEventListener('focus', () => handleItemTitleFocus(titleEl, item.id));
    titleEl.addEventListener('blur', () => handleItemTitleBlur(titleEl, item.id));
    titleEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        titleEl.blur();
      }
    });

    const payload = node.querySelector('.item-payload');
    payload.value = item.payload;
    payload.addEventListener('input', () => handlePayloadChange(item.id, payload.value));

    const moveBtn = node.querySelector('.item-move');
    moveBtn.addEventListener('click', () => openMoveOverlay(item.id));

    const deleteBtn = node.querySelector('.item-delete');
    deleteBtn.addEventListener('click', () => deleteItem(item.id));

    node.addEventListener('pointerdown', (event) => beginItemDrag(event, node, list.id));
    node.addEventListener('pointermove', handleItemDragMove);
    node.addEventListener('pointerup', handleItemDragEnd);
    node.addEventListener('pointercancel', handleItemDragEnd);

    node.addEventListener('focusin', () => setActiveItem(item.id));
    node.addEventListener('click', (event) => {
      if (event.target.classList.contains('item-card')) {
        setActiveItem(item.id);
      }
    });

    if (state.activeItemId === item.id) {
      node.dataset.active = 'true';
    }

    const meta = node.querySelector('.item-meta');
    meta.textContent = describeItem(item);

    fragment.appendChild(node);
  });
  listEl.appendChild(fragment);
}

function renderCollectionView(collection) {
  elements.contextTitle.textContent = collection.name;
  elements.contextTitle.dataset.type = 'collection';
  elements.contextTitle.dataset.id = collection.id;
  elements.assignShortcut.hidden = true;
  elements.deleteCollection.hidden = false;
  elements.deleteCollection.dataset.collectionId = collection.id;
  elements.addItem.disabled = true;
  elements.addItem.hidden = true;

  renderCollectionMembership(collection);

  const listEl = elements.itemList;
  listEl.innerHTML = '';
  listEl.classList.add('collection-mode');

  const fragment = document.createDocumentFragment();
  collection.listIds.forEach((listId) => {
    const list = state.lists.get(listId);
    if (!list) return;
    const groupHeader = document.createElement('li');
    groupHeader.className = 'collection-group';
    groupHeader.innerHTML = `<strong>${escapeHtml(list.name)}</strong><span class="badge">${list.itemIds.length}</span>`;
    groupHeader.tabIndex = 0;
    groupHeader.addEventListener('click', () => selectContext('list', list.id));
    fragment.appendChild(groupHeader);

    list.itemIds.forEach((itemId) => {
      const item = state.items.get(itemId);
      if (!item) return;
      const node = elements.itemTemplate.content.firstElementChild.cloneNode(true);
      node.dataset.id = item.id;
      node.dataset.listId = list.id;
      node.classList.add('readonly');
      const titleEl = node.querySelector('.item-title');
      renderItemTitle(titleEl, item.title);
      titleEl.setAttribute('contenteditable', 'false');
      const payload = node.querySelector('.item-payload');
      payload.value = item.payload;
      payload.setAttribute('readonly', 'true');
      payload.classList.add('readonly');
      node.querySelector('.item-toolbar').remove();
      node.querySelector('.item-meta').textContent = describeItem(item);
      fragment.appendChild(node);
    });
  });
  listEl.appendChild(fragment);
}

function renderCollectionMembership(collection) {
  elements.collectionMembership.innerHTML = '';
  elements.collectionMembership.hidden = false;
  const fragment = document.createDocumentFragment();
  const label = document.createElement('span');
  label.textContent = 'Included lists:';
  fragment.appendChild(label);

  state.lists.forEach((list) => {
    const wrapper = document.createElement('label');
    wrapper.className = 'membership-item';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = collection.listIds.includes(list.id);
    checkbox.addEventListener('change', () => toggleCollectionMembership(collection.id, list.id, checkbox.checked));
    wrapper.appendChild(checkbox);
    wrapper.appendChild(document.createTextNode(list.name));
    fragment.appendChild(wrapper);
  });
  elements.collectionMembership.appendChild(fragment);
}

function toggleCollectionMembership(collectionId, listId, shouldInclude) {
  const collection = state.collections.get(collectionId);
  if (!collection) return;
  if (shouldInclude) {
    if (!collection.listIds.includes(listId)) {
      collection.listIds.push(listId);
    }
  } else {
    collection.listIds = collection.listIds.filter((id) => id !== listId);
  }
  renderSidebarCollections();
  if (state.selected?.type === 'collection' && state.selected.id === collectionId) {
    renderCollectionView(collection);
  }
}

function renderItemTitle(element, title) {
  const trimmed = title.trim();
  if (!trimmed) {
    element.dataset.empty = 'true';
    element.innerHTML = '';
    return;
  }
  element.dataset.empty = 'false';
  element.innerHTML = highlightTags(escapeHtml(trimmed));
}

function handleItemTitleFocus(element, itemId) {
  const item = state.items.get(itemId);
  if (!item) return;
  element.dataset.editing = 'true';
  element.textContent = item.title;
}

function handleItemTitleBlur(element, itemId) {
  const item = state.items.get(itemId);
  if (!item) return;
  const nextTitle = element.textContent?.trim() ?? '';
  if (item.title !== nextTitle) {
    item.title = nextTitle;
    item.updatedAt = new Date().toISOString();
  }
  element.dataset.editing = 'false';
  renderItemTitle(element, item.title);
  refreshItemMeta(itemId);
  renderSidebarLists();
}

function handlePayloadChange(itemId, value) {
  const item = state.items.get(itemId);
  if (!item) return;
  item.payload = value;
  item.updatedAt = new Date().toISOString();
  refreshItemMeta(itemId);
}

function refreshItemMeta(itemId) {
  const item = state.items.get(itemId);
  if (!item) return;
  const card = elements.itemList.querySelector(`.item-card[data-id="${itemId}"]`);
  if (card) {
    const meta = card.querySelector('.item-meta');
    if (meta) {
      meta.textContent = describeItem(item);
    }
  }
}

function describeItem(item) {
  const tags = extractTags(item.title);
  const parts = [];
  if (tags.length) {
    parts.push(`#${tags.length} tags`);
  }
  const updated = new Date(item.updatedAt);
  parts.push(`Updated ${relativeTime(updated)}`);
  return parts.join(' · ');
}

function extractTags(text) {
  const regex = /([#@][\w]+)/g;
  const matches = text.match(regex);
  return matches ? matches.map((tag) => tag.slice(1)) : [];
}

function highlightTags(html) {
  return html.replace(/([#@][a-zA-Z0-9_]+)/g, '<span class="tag">$1</span>');
}

function relativeTime(date) {
  const now = new Date();
  const diff = now - date;
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function setActiveItem(itemId) {
  state.activeItemId = itemId;
  elements.itemList.querySelectorAll('.item-card').forEach((card) => {
    card.dataset.active = card.dataset.id === itemId ? 'true' : 'false';
  });
}

let dragState = null;

function beginItemDrag(event, card, listId) {
  if (!event.isPrimary) return;
  const handle = event.target.closest('.item-handle');
  if (!handle) return;
  event.preventDefault();
  const itemId = card.dataset.id;
  dragState = {
    itemId,
    listId,
    pointerId: event.pointerId,
    startY: event.clientY,
    offsetY: 0,
  };
  card.setPointerCapture(event.pointerId);
  card.classList.add('dragging');
  document.body.classList.add('drag-active');
  setActiveItem(itemId);
}

function handleItemDragMove(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const card = event.currentTarget;
  dragState.offsetY = event.clientY - dragState.startY;
  card.style.transform = `translateY(${dragState.offsetY}px)`;
  const target = document.elementFromPoint(event.clientX, event.clientY);
  const overCard = target?.closest('.item-card');
  if (!overCard || overCard === card) return;
  reorderItems(dragState.itemId, overCard.dataset.id, dragState.listId);
  dragState.startY = event.clientY;
  card.style.transform = 'translateY(0px)';
}

function handleItemDragEnd(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const card = event.currentTarget;
  card.releasePointerCapture(event.pointerId);
  card.classList.remove('dragging');
  card.style.transform = '';
  dragState = null;
  document.body.classList.remove('drag-active');
}

function reorderItems(draggedId, targetId, listId) {
  const list = state.lists.get(listId);
  if (!list) return;
  const from = list.itemIds.indexOf(draggedId);
  const to = list.itemIds.indexOf(targetId);
  if (from === -1 || to === -1 || from === to) return;
  list.itemIds.splice(from, 1);
  list.itemIds.splice(to, 0, draggedId);
  const listEl = elements.itemList;
  const draggedEl = listEl.querySelector(`.item-card[data-id="${draggedId}"]`);
  const targetEl = listEl.querySelector(`.item-card[data-id="${targetId}"]`);
  if (!draggedEl || !targetEl) return;
  if (from < to) {
    listEl.insertBefore(draggedEl, targetEl.nextSibling);
  } else {
    listEl.insertBefore(draggedEl, targetEl);
  }
}

function openMoveOverlay(itemId) {
  state.activeItemId = itemId;
  elements.moveOverlay.classList.remove('hidden');
  elements.moveInput.value = '';
  renderMoveResults('');
  setTimeout(() => {
    elements.moveInput.focus();
  }, 0);
}

function closeMoveOverlay() {
  elements.moveOverlay.classList.add('hidden');
  elements.moveInput.value = '';
  elements.moveResults.innerHTML = '';
}

function renderMoveResults(query) {
  const activeItem = state.items.get(state.activeItemId);
  if (!activeItem) return;
  const currentListId = activeItem.listId;
  const results = [...state.lists.values()]
    .filter((list) => list.id !== currentListId)
    .map((list) => ({ list, score: fuzzyScore(query, list.name) }))
    .filter(({ score }) => score > -Infinity)
    .sort((a, b) => b.score - a.score || a.list.name.localeCompare(b.list.name));
  elements.moveResults.innerHTML = '';
  const fragment = document.createDocumentFragment();
  results.slice(0, 12).forEach(({ list }, index) => {
    const li = document.createElement('li');
    li.className = 'move-result';
    li.role = 'option';
    li.dataset.id = list.id;
    li.textContent = list.name;
    li.setAttribute('aria-selected', index === 0 ? 'true' : 'false');
    li.addEventListener('click', () => {
      moveItemToList(activeItem.id, list.id);
      closeMoveOverlay();
    });
    fragment.appendChild(li);
  });
  if (!fragment.childNodes.length) {
    const empty = document.createElement('li');
    empty.className = 'move-result';
    empty.textContent = 'No lists found';
    fragment.appendChild(empty);
  }
  elements.moveResults.appendChild(fragment);
}

function moveItemToList(itemId, listId) {
  const item = state.items.get(itemId);
  if (!item) return;
  const fromList = state.lists.get(item.listId);
  const toList = state.lists.get(listId);
  if (!toList) return;
  if (fromList) {
    fromList.itemIds = fromList.itemIds.filter((id) => id !== itemId);
  }
  toList.itemIds.push(itemId);
  item.listId = toList.id;
  item.updatedAt = new Date().toISOString();
  renderSidebarLists();
  if (state.selected?.type === 'list') {
    if (state.selected.id === fromList?.id || state.selected.id === toList.id) {
      renderListView(state.lists.get(state.selected.id));
    }
  }
}

function openSearchOverlay() {
  if (!state.selected) return;
  elements.searchOverlay.classList.remove('hidden');
  const scopeText = state.selected.type === 'list'
    ? `Searching in list: ${state.lists.get(state.selected.id)?.name ?? ''}`
    : `Searching in collection: ${state.collections.get(state.selected.id)?.name ?? ''}`;
  elements.searchScope.textContent = scopeText;
  elements.searchInput.value = '';
  renderSearchResults('');
  setTimeout(() => {
    elements.searchInput.focus();
  }, 0);
}

function closeSearchOverlay() {
  elements.searchOverlay.classList.add('hidden');
  elements.searchResults.innerHTML = '';
  elements.searchInput.value = '';
}

function renderSearchResults(query) {
  const trimmed = query.trim();
  const scopeItems = getItemsInCurrentScope();
  const results = scopeItems
    .map((item) => ({ item, list: state.lists.get(item.listId), score: searchScore(trimmed, item) }))
    .filter(({ score }) => score > -Infinity)
    .sort((a, b) => b.score - a.score || a.item.updatedAt.localeCompare(b.item.updatedAt));

  elements.searchResults.innerHTML = '';
  const fragment = document.createDocumentFragment();

  if (!results.length) {
    const li = document.createElement('li');
    li.className = 'search-result';
    li.textContent = trimmed ? 'No matches yet' : 'Start typing to search';
    fragment.appendChild(li);
  } else {
    results.slice(0, 20).forEach(({ item, list }) => {
      const li = document.createElement('li');
      li.className = 'search-result';
      li.innerHTML = `
        <div class="result-title">${highlightTags(escapeHtml(item.title || '(untitled)'))}</div>
        <div class="match-meta">${list?.name ?? ''} · ${describeItem(item)}</div>
      `;
      li.addEventListener('click', () => {
        closeSearchOverlay();
        selectContext('list', item.listId);
        requestAnimationFrame(() => {
          const card = elements.itemList.querySelector(`.item-card[data-id="${item.id}"]`);
          if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.focus({ preventScroll: true });
          }
          setActiveItem(item.id);
        });
      });
      fragment.appendChild(li);
    });
  }
  elements.searchResults.appendChild(fragment);
}

function getItemsInCurrentScope() {
  if (!state.selected) return [];
  if (state.selected.type === 'list') {
    const list = state.lists.get(state.selected.id);
    if (!list) return [];
    return list.itemIds.map((id) => state.items.get(id)).filter(Boolean);
  }
  const collection = state.collections.get(state.selected.id);
  if (!collection) return [];
  const items = [];
  collection.listIds.forEach((listId) => {
    const list = state.lists.get(listId);
    if (!list) return;
    list.itemIds.forEach((itemId) => {
      const item = state.items.get(itemId);
      if (item) items.push(item);
    });
  });
  return items;
}

function searchScore(query, item) {
  if (!query) return 0;
  const title = item.title.toLowerCase();
  const payload = item.payload.toLowerCase();
  const q = query.toLowerCase();
  if (title.includes(q)) return 200 - title.indexOf(q);
  if (payload.includes(q)) return 150 - payload.indexOf(q);
  const tags = extractTags(item.title).join(' ').toLowerCase();
  if (tags.includes(q)) return 100 - tags.indexOf(q);
  return -Infinity;
}

function fuzzyScore(query, text) {
  if (!query) return 0;
  const q = query.toLowerCase();
  const target = text.toLowerCase();
  if (target.includes(q)) return 200 - target.indexOf(q);
  // simple subsequence match
  let score = 0;
  let ti = 0;
  for (let qi = 0; qi < q.length; qi += 1) {
    const char = q[qi];
    const index = target.indexOf(char, ti);
    if (index === -1) return -Infinity;
    score += 10 - Math.min(9, index - ti);
    ti = index + 1;
  }
  return score;
}

function formatShortcut(shortcut) {
  const parts = [];
  if (shortcut.ctrlKey) parts.push('Ctrl');
  if (shortcut.altKey) parts.push('Alt');
  if (shortcut.shiftKey) parts.push('Shift');
  if (shortcut.metaKey) parts.push('Meta');
  parts.push(shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key);
  return parts.join('+');
}

function shortcutMatches(shortcut, event) {
  return (
    shortcut.key.toLowerCase() === event.key.toLowerCase() &&
    shortcut.ctrlKey === event.ctrlKey &&
    shortcut.altKey === event.altKey &&
    shortcut.shiftKey === event.shiftKey &&
    shortcut.metaKey === event.metaKey
  );
}

function bindEvents() {
  document.getElementById('create-list').addEventListener('click', () => {
    const name = prompt('List name?');
    if (!name) return;
    const list = createList(name.trim());
    renderSidebarLists();
    selectContext('list', list.id);
  });

  document.getElementById('create-collection').addEventListener('click', () => {
    const name = prompt('Collection name?');
    if (!name) return;
    const collection = createCollection(name.trim());
    renderSidebarCollections();
    selectContext('collection', collection.id);
  });

  elements.deleteCollection.addEventListener('click', () => {
    const collectionId = elements.deleteCollection.dataset.collectionId;
    const collection = state.collections.get(collectionId);
    if (!collection) return;
    const confirmed = confirm(`Delete collection "${collection.name}"?`);
    if (!confirmed) return;
    deleteCollection(collectionId);
  });

  elements.addItem.addEventListener('click', () => {
    if (state.selected?.type !== 'list') return;
    const listId = state.selected.id;
    const item = createItem(listId, '', '');
    item.updatedAt = new Date().toISOString();
    renderListView(state.lists.get(listId));
    setActiveItem(item.id);
    const card = elements.itemList.querySelector(`.item-card[data-id="${item.id}"]`);
    card?.querySelector('.item-title')?.focus();
    renderSidebarLists();
  });

  elements.contextTitle.addEventListener('focus', (event) => {
    if (!state.selected) return;
    const { type, id } = state.selected;
    const name = type === 'list' ? state.lists.get(id)?.name : state.collections.get(id)?.name;
    event.target.textContent = name ?? '';
  });

  elements.contextTitle.addEventListener('blur', (event) => {
    if (!state.selected) return;
    const nextName = event.target.textContent?.trim() ?? '';
    const { type, id } = state.selected;
    if (!nextName) {
      renderMain();
      return;
    }
    if (type === 'list') {
      const list = state.lists.get(id);
      if (list && list.name !== nextName) {
        list.name = nextName;
        renderSidebarLists();
      }
    } else if (type === 'collection') {
      const collection = state.collections.get(id);
      if (collection && collection.name !== nextName) {
        collection.name = nextName;
        renderSidebarCollections();
      }
    }
    renderMain();
  });

  elements.contextTitle.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      elements.contextTitle.blur();
    }
  });

  elements.assignShortcut.addEventListener('click', () => {
    const listId = elements.assignShortcut.dataset.listId;
    if (!listId) return;
    elements.assignShortcut.textContent = 'Press shortcut…';
    state.shortcutCapture = listId;
  });

  elements.searchButton.addEventListener('click', openSearchOverlay);

  elements.searchInput.addEventListener('input', () => {
    renderSearchResults(elements.searchInput.value);
  });

  elements.moveInput.addEventListener('input', () => {
    renderMoveResults(elements.moveInput.value);
  });

  elements.searchOverlay.addEventListener('click', (event) => {
    if (event.target === elements.searchOverlay) {
      closeSearchOverlay();
    }
  });

  elements.moveOverlay.addEventListener('click', (event) => {
    if (event.target === elements.moveOverlay) {
      closeMoveOverlay();
    }
  });

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.close;
      if (target === 'search') closeSearchOverlay();
      if (target === 'move') closeMoveOverlay();
    });
  });

  document.addEventListener('keydown', handleGlobalKeyDown);
}

function handleGlobalKeyDown(event) {
  if (state.shortcutCapture) {
    event.preventDefault();
    if (event.key === 'Escape') {
      state.shortcutCapture = null;
      const list = state.lists.get(elements.assignShortcut.dataset.listId);
      elements.assignShortcut.textContent = list?.shortcut ? formatShortcut(list.shortcut) : 'Set Shortcut';
      return;
    }
    const list = state.lists.get(state.shortcutCapture);
    if (!list) return;
    list.shortcut = {
      key: event.key,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
    };
    elements.assignShortcut.textContent = formatShortcut(list.shortcut);
    renderSidebarLists();
    state.shortcutCapture = null;
    return;
  }

  const target = event.target;
  const isTyping = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
  if (isTyping) {
    if (event.key === 'Escape') {
      if (!elements.searchOverlay.classList.contains('hidden')) {
        closeSearchOverlay();
      }
      if (!elements.moveOverlay.classList.contains('hidden')) {
        closeMoveOverlay();
      }
    }
    return;
  }

  if (!elements.searchOverlay.classList.contains('hidden')) {
    if (event.key === 'Escape') {
      closeSearchOverlay();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      cycleMoveSelection(elements.searchResults, event.key === 'ArrowDown');
      return;
    }
  }

  if (!elements.moveOverlay.classList.contains('hidden')) {
    if (event.key === 'Escape') {
      closeMoveOverlay();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      cycleMoveSelection(elements.moveResults, event.key === 'ArrowDown');
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const selected = elements.moveResults.querySelector('[aria-selected="true"]');
      if (selected) {
        moveItemToList(state.activeItemId, selected.dataset.id);
        closeMoveOverlay();
      }
      return;
    }
  }

  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'm') {
    event.preventDefault();
    if (state.activeItemId) {
      openMoveOverlay(state.activeItemId);
    }
    return;
  }

  for (const list of state.lists.values()) {
    if (list.shortcut && shortcutMatches(list.shortcut, event)) {
      event.preventDefault();
      if (state.activeItemId) {
        moveItemToList(state.activeItemId, list.id);
      }
      return;
    }
  }

  if (event.key === '/' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    openSearchOverlay();
  }
}

function cycleMoveSelection(listElement, forward) {
  const options = [...listElement.querySelectorAll('[aria-selected]')];
  if (!options.length) return;
  const currentIndex = options.findIndex((el) => el.getAttribute('aria-selected') === 'true');
  const nextIndex = (currentIndex + (forward ? 1 : -1) + options.length) % options.length;
  options.forEach((el, index) => {
    el.setAttribute('aria-selected', index === nextIndex ? 'true' : 'false');
    if (index === nextIndex) {
      el.scrollIntoView({ block: 'nearest' });
    }
  });
}

function initialize() {
  seedData();
  bindEvents();
  renderSidebarLists();
  renderSidebarCollections();
  const firstList = state.lists.values().next().value;
  if (firstList) {
    selectContext('list', firstList.id);
  }
}

initialize();
