const STORAGE_KEY = 'hookrelay.labs.reviewed.v1';

const state = {
  topics: [],
  currentId: null,
  filter: '',
  reviewed: new Set(),
  glossary: [],
  termSeen: new Set(),
  glossaryGroups: [],
};

let termIndex = null;
let termPattern = null;

const TERM_ESCAPE = /[.*+?^${}()|[\]\\]/g;

/** Builds one alternation from every linkable form, longest first so `long-poll` beats `polling`. */
function buildTermIndex(groups) {
  state.glossaryGroups = groups;
  state.glossary = groups.flatMap((group) => group.entries);

  const index = new Map();
  const forms = [];
  for (const entry of state.glossary) {
    if (entry.autoLink === false) continue;
    for (const form of [entry.term, ...(entry.match ?? [])]) {
      if (form.length < 3) continue;
      const key = form.toLowerCase();
      if (!index.has(key)) index.set(key, { entry, form });
      forms.push(form);
    }
  }

  forms.sort((a, b) => b.length - a.length);
  termIndex = index;
  termPattern =
    forms.length === 0
      ? null
      : new RegExp(
          `(?<![A-Za-z0-9_])(${forms.map((form) => form.replace(TERM_ESCAPE, '\\$&')).join('|')})(?![A-Za-z0-9_])`,
          'gi',
        );
}

/** Wraps the first mention of each term per topic in a hoverable explanation. */
function decorate(text) {
  const source = String(text);
  if (!termPattern || source.length === 0) return document.createTextNode(source);

  const fragment = document.createDocumentFragment();
  let cursor = 0;

  for (const match of source.matchAll(termPattern)) {
    const hit = termIndex.get(match[0].toLowerCase());
    if (!hit) continue;
    const { entry, form } = hit;
    // Acronyms must match case exactly: `id` should not explain `ID`.
    if (entry.caseSensitive && match[0] !== form) continue;
    if (state.termSeen.has(entry.term)) continue;

    const index = match.index ?? 0;
    if (index > cursor) fragment.append(document.createTextNode(source.slice(cursor, index)));

    state.termSeen.add(entry.term);
    fragment.append(
      el(
        'abbr',
        {
          class: 'term',
          title: `${entry.full}: ${entry.plain}`,
          tabindex: '0',
          onclick: () => openGlossary(entry.term),
        },
        match[0],
      ),
    );
    cursor = index + match[0].length;
  }

  if (cursor < source.length) fragment.append(document.createTextNode(source.slice(cursor)));
  return fragment;
}

function loadReviewed() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) state.reviewed = new Set(parsed.filter((v) => typeof v === 'string'));
  } catch {
    state.reviewed = new Set();
  }
}

function saveReviewed() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...state.reviewed]));
  } catch {
    /* storage may be disabled; progress is a convenience, not state */
  }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset' && typeof value === 'object') {
      Object.assign(node.dataset, value);
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function code(text) {
  return el('code', { text });
}

/** Renders `code` and **bold** segments without touching innerHTML. */
function inline(text) {
  const source = String(text);
  const fragment = document.createDocumentFragment();
  const tokenPattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let cursor = 0;

  for (const match of source.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    if (index > cursor) fragment.append(decorate(source.slice(cursor, index)));

    const token = match[0];
    if (token.startsWith('`')) {
      fragment.append(el('code', { class: 'inline', text: token.slice(1, -1) }));
    } else {
      fragment.append(el('strong', {}, decorate(token.slice(2, -2))));
    }
    cursor = index + token.length;
  }

  if (cursor < source.length) fragment.append(decorate(source.slice(cursor)));
  return fragment;
}

/* ---------------- navigation ---------------- */

function renderNav() {
  const nav = document.getElementById('topic-nav');
  nav.replaceChildren();

  const query = state.filter.trim().toLowerCase();
  const visible = state.topics.filter((topic) => {
    if (!query) return true;
    return `${topic.title} ${topic.summary} ${topic.keyIdeas.join(' ')}`
      .toLowerCase()
      .includes(query);
  });

  if (visible.length === 0) {
    nav.append(el('p', { class: 'empty', text: 'No topic matches that filter.' }));
  }

  for (const topic of visible) {
    const reviewed = state.reviewed.has(topic.id);
    const dotClass = reviewed ? 'nav-dot done' : topic.status === 'reference' ? 'nav-dot ref' : 'nav-dot';

    nav.append(
      el(
        'button',
        {
          type: 'button',
          class: 'nav-item',
          'aria-current': String(topic.id === state.currentId),
          onclick: () => selectTopic(topic.id, true),
        },
        el('span', { class: 'nav-num', text: String(topic.order).padStart(2, '0') }),
        el('span', { text: topic.title }),
        el('span', { class: dotClass, title: reviewed ? 'Reviewed' : topic.status }),
      ),
    );
  }
}

function renderProgress() {
  const total = state.topics.length;
  const done = state.topics.filter((topic) => state.reviewed.has(topic.id)).length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);

  document.getElementById('progress-fill').style.width = `${pct}%`;
  document.getElementById('progress-label').textContent = `${done} of ${total} reviewed`;
}

function selectTopic(id, updateHash) {
  const topic = state.topics.find((t) => t.id === id) ?? state.topics[0];
  if (!topic) return;

  state.currentId = topic.id;
  if (updateHash) history.replaceState(null, '', `#/${topic.id}`);

  renderNav();
  renderTopic(topic);
  renderProgress();
  document.getElementById('main').focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------------- topic rendering ---------------- */

function renderTopic(topic) {
  const main = document.getElementById('main');
  main.replaceChildren();
  state.termSeen = new Set();

  const head = el(
    'header',
    {},
    el(
      'div',
      { class: 'topic-head' },
      el('span', { class: 'pill', text: `Phase ${topic.phase}` }),
      el('span', {
        class: `pill ${topic.status === 'live' ? 'live' : 'reference'}`,
        text: topic.status === 'live' ? 'hands-on' : 'reference only',
      }),
      el('span', { class: 'pill', text: `${topic.actions.length} demo${topic.actions.length === 1 ? '' : 's'}` }),
    ),
    el('h1', { text: topic.title }),
    el('p', { class: 'summary' }, inline(topic.summary)),
    state.glossary.length > 0
      ? el('p', {
          class: 'term-hint',
          text: 'Dotted-underline words are explained in the glossary: hover one, or press it to read the full entry.',
        })
      : null,
  );

  const ideas = el(
    'section',
    { class: 'ideas' },
    el('h2', { text: 'Key ideas' }),
    el('ul', {}, topic.keyIdeas.map((idea) => el('li', {}, inline(idea)))),
  );

  const demoAccordion = accordion(
    `Live demos (${topic.actions.length})`,
    topic.actions.length > 0,
    renderDemos(topic),
  );

  const codeAccordion = accordion(
    `Code snippets (${topic.snippets.length})`,
    false,
    topic.snippets.length > 0
      ? topic.snippets.map(renderSnippet)
      : [el('p', { class: 'empty', text: 'No snippets for this topic.' })],
  );

  const drillAccordion = accordion(
    `Interview drill (${topic.interviewQuestions.length})`,
    false,
    el('ol', { class: 'drill' }, topic.interviewQuestions.map((q) => el('li', {}, inline(q)))),
  );

  const reviewed = el('input', {
    type: 'checkbox',
    id: `reviewed-${topic.id}`,
    checked: state.reviewed.has(topic.id),
    onchange: (event) => {
      if (event.target.checked) state.reviewed.add(topic.id);
      else state.reviewed.delete(topic.id);
      saveReviewed();
      renderProgress();
      renderNav();
    },
  });

  main.append(
    head,
    ideas,
    demoAccordion,
    codeAccordion,
    drillAccordion,
    el(
      'div',
      { class: 'reviewed-row' },
      reviewed,
      el('label', { for: `reviewed-${topic.id}`, text: 'I can explain this topic out loud without notes' }),
    ),
  );
}

function accordion(title, open, body) {
  const details = el(
    'details',
    { class: 'acc' },
    el('summary', { text: title }),
    el('div', { class: 'acc-body' }, body),
  );
  if (open) details.open = true;
  return details;
}

function renderSnippet(snippet) {
  const copyButton = el('button', {
    type: 'button',
    class: 'copy',
    text: 'copy',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(snippet.code);
        copyButton.textContent = 'copied';
      } catch {
        copyButton.textContent = 'select manually';
      }
      setTimeout(() => {
        copyButton.textContent = 'copy';
      }, 1400);
    },
  });

  return el(
    'div',
    { class: 'snippet' },
    el(
      'div',
      { class: 'snippet-head' },
      el('span', { text: `${snippet.label} · ${snippet.language}` }),
      copyButton,
    ),
    el('pre', {}, code(snippet.code)),
  );
}

/* ---------------- demos ---------------- */

function renderDemos(topic) {
  if (topic.actions.length === 0) {
    return el('p', {
      class: 'empty',
      text: 'This is a reference card: the concepts are documented here, but nothing is wired to run.',
    });
  }

  const registry = new Map();
  const cards = topic.actions.map((action) => renderActionCard(topic, action, registry));

  const hasRunnable = topic.actions.some((action) => !action.heavy);
  const runAllButton = el('button', {
    type: 'button',
    class: 'btn subtle',
    text: 'Run all (skips heavy)',
    disabled: !hasRunnable,
    onclick: () => runAll(topic, registry, runAllButton),
  });

  return [el('div', { class: 'run-all' }, runAllButton), ...cards];
}

function renderActionCard(topic, action, registry) {
  const slot = el('div');
  const button = el('button', {
    type: 'button',
    class: 'btn',
    text: 'Run',
    'data-run': action.id,
  });

  registry.set(action.id, { button, slot });

  button.addEventListener('click', async () => {
    if (action.heavy && !window.confirm(`${action.label} is heavy and may take a few seconds. Continue?`)) {
      return;
    }
    await execute(topic.id, action, slot, button);
  });

  return el(
    'div',
    {},
    el(
      'div',
      { class: 'action' },
      el(
        'div',
        {},
        el(
          'div',
          { class: 'action-title' },
          action.label,
          action.heavy ? el('span', { class: 'badge-heavy', text: 'heavy' }) : null,
        ),
        el('div', { class: 'action-desc', text: action.description }),
      ),
      button,
    ),
    slot,
  );
}

async function execute(topicId, action, slot, button) {
  button.disabled = true;
  const original = button.textContent;
  button.textContent = 'Running…';
  slot.replaceChildren(el('p', { class: 'empty', text: 'Working…' }));

  try {
    const response = await fetch(`/labs/api/actions/${encodeURIComponent(action.id)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    const payload = await response.json();

    if (!response.ok) {
      slot.replaceChildren(
        el(
          'div',
          { class: 'result fail' },
          el(
            'div',
            { class: 'result-head' },
            el('span', { class: 'status-chip', text: String(response.status) }),
            el('span', { text: action.id }),
          ),
          el('h3', { text: payload?.error?.code ?? 'Request failed' }),
          el('p', { text: payload?.error?.message ?? 'Unknown error' }),
        ),
      );
      return;
    }

    slot.replaceChildren(renderActionResult(payload, action));
  } catch (error) {
    slot.replaceChildren(
      el(
        'div',
        { class: 'result fail' },
        el('div', { class: 'result-head' }, el('span', { class: 'status-chip', text: 'network' })),
        el('h3', { text: 'Could not reach the server' }),
        el('p', { text: String(error?.message ?? error) }),
      ),
    );
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function runAll(topic, registry, trigger) {
  const runnable = topic.actions.filter((action) => !action.heavy);
  trigger.disabled = true;
  trigger.textContent = 'Running…';

  try {
    for (const action of runnable) {
      const entry = registry.get(action.id);
      if (!entry) continue;
      await execute(topic.id, action, entry.slot, entry.button);
    }
  } finally {
    trigger.disabled = false;
    trigger.textContent = 'Run all (skips heavy)';
  }
}

function renderActionResult(payload, action) {
  const { data, durationMs } = payload;

  const parts = [
    el(
      'div',
      { class: 'result-head' },
      el('span', { class: 'status-chip', text: '200' }),
      el('span', { text: `${action.id} · ${durationMs} ms` }),
    ),
    el('h3', { text: data.title }),
    el('p', { text: data.summary }),
  ];

  if (data.table) parts.push(renderTable(data.table));

  if (data.sql) {
    parts.push(el('div', { class: 'snippet', style: 'margin-top:10px' }, el('pre', {}, code(data.sql))));
  }

  if (data.notes?.length) {
    parts.push(el('ul', { class: 'notes' }, data.notes.map((note) => el('li', {}, inline(note)))));
  }

  if (data.raw !== undefined) {
    parts.push(
      el(
        'details',
        { class: 'raw' },
        el('summary', { text: 'raw response' }),
        el('pre', {}, code(JSON.stringify(data.raw, null, 2))),
      ),
    );
  }

  return el('div', { class: 'result ok' }, parts);
}

function renderTable(table) {
  const head = el(
    'thead',
    {},
    el('tr', {}, table.columns.map((column) => el('th', { text: column }))),
  );

  const body = el(
    'tbody',
    {},
    table.rows.map((row) =>
      el(
        'tr',
        {},
        row.map((cell) => {
          const isNumber = typeof cell === 'number';
          const text = cell === null || cell === undefined ? 'n/a' : String(cell);
          return el('td', { class: isNumber ? 'num' : '', text });
        }),
      ),
    ),
  );

  return el('table', {}, head, body);
}

/* ---------------- glossary ---------------- */

function openGlossary(term) {
  const dialog = document.getElementById('glossary');
  const filter = document.getElementById('glossary-filter');

  filter.value = term ?? '';
  renderGlossary(filter.value);
  if (!dialog.open) dialog.showModal();

  filter.focus();
  filter.select();
}

function renderGlossary(query = '') {
  const body = document.getElementById('glossary-body');
  body.replaceChildren();

  const needle = query.trim().toLowerCase();
  const matches = (entry) =>
    needle === '' || `${entry.term} ${entry.full} ${entry.plain}`.toLowerCase().includes(needle);

  let shown = 0;

  for (const group of state.glossaryGroups) {
    const entries = group.entries.filter(matches);
    if (entries.length === 0) continue;

    const list = el('dl', {});
    for (const entry of entries) {
      shown += 1;
      list.append(
        el(
          'div',
          {
            class: `glossary-entry${needle && entry.term.toLowerCase() === needle ? ' hit' : ''}`,
          },
          el('dt', { text: entry.term }),
          el(
            'dd',
            {},
            el('strong', { text: entry.full }),
            el('span', { class: 'plain', text: `: ${entry.plain}` }),
          ),
        ),
      );
    }

    body.append(el('section', { class: 'glossary-group' }, el('h3', { text: group.label }), list));
  }

  if (shown === 0) {
    body.append(el('p', { class: 'glossary-empty', text: 'No term matches that search.' }));
  }
}

/* ---------------- boot ---------------- */

async function boot() {
  loadReviewed();

  const filter = document.getElementById('filter');
  filter.addEventListener('input', () => {
    state.filter = filter.value;
    renderNav();
  });

  document.getElementById('reset-progress').addEventListener('click', () => {
    state.reviewed.clear();
    saveReviewed();
    renderNav();
    renderProgress();
    if (state.currentId) {
      const topic = state.topics.find((t) => t.id === state.currentId);
      if (topic) renderTopic(topic);
    }
  });

  document.getElementById('open-glossary').addEventListener('click', () => openGlossary());
  document.getElementById('close-glossary').addEventListener('click', () => {
    document.getElementById('glossary').close();
  });
  document.getElementById('glossary-filter').addEventListener('input', (event) => {
    renderGlossary(event.target.value);
  });
  // Clicking the backdrop closes the dialog, like every other modal.
  document.getElementById('glossary').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });

  // The glossary is optional: if it fails, the labs still work, just without
  // hover explanations.
  try {
    const glossaryResponse = await fetch('/labs/api/glossary');
    if (glossaryResponse.ok) {
      const payload = await glossaryResponse.json();
      buildTermIndex(payload.groups ?? []);
    }
  } catch {
    buildTermIndex([]);
  }

  try {
    const response = await fetch('/labs/api/topics');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    state.topics = payload.topics ?? [];
  } catch (error) {
    document.getElementById('main').replaceChildren(
      el('h1', { text: 'Could not load topics' }),
      el('p', { class: 'summary', text: String(error?.message ?? error) }),
    );
    return;
  }

  const fromHash = location.hash.replace(/^#\//, '');
  const initial = state.topics.some((t) => t.id === fromHash) ? fromHash : state.topics[0]?.id;

  // Deep links (#/queues) must work without a reload.
  window.addEventListener('hashchange', () => {
    const id = location.hash.replace(/^#\//, '');
    if (!id || id === state.currentId) return;
    if (!state.topics.some((t) => t.id === id)) return;
    selectTopic(id, false);
  });

  selectTopic(initial, false);
  renderProgress();
}

boot();
