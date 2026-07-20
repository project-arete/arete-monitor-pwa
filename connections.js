// connections.js — the Connections view: one panel per governed binding.
// Layout: provider (system/node) on the LEFT, consumer (system/node) on the
// RIGHT, and the CONTEXT the connection is created for in the MIDDLE. Expands to
// the shared property table. Consumes AreteModel; applies no CP semantics.
(function () {
  const root = document.getElementById('connections-root');
  if (!root || !window.AreteModel) return;
  const { esc, parseKeys, getKeys, propTable, regFor, ensureProfile, onChange } = window.AreteModel;

  const state = { expanded: new Set() };
  let prevVals = {};
  // Value-change highlight is driven by state (a per-connection "changed at"
  // timestamp) and held for HOLD_MS, so it survives the full-list re-renders
  // that fire on every update — unlike a one-shot CSS animation, which gets cut
  // when the DOM element is rebuilt.
  const HOLD_MS = 3000;
  const lastChanged = {}; // connId -> Date.now()
  let holdTimer = null;

  // party = System (primary) › Node (secondary) › role (smallest, faintest)
  function party(label, role) {
    if (!label) return `<div class="cparty ${role} empty-side"><span class="chip unbound"><span class="c-dot"></span>awaiting ${role}</span></div>`;
    return `<div class="cparty ${role}">
      <div class="pty-sys">${esc(label.system)}</div>
      <div class="pty-node">${esc(label.node)}</div>
      <div class="pty-role">${role}</div>
    </div>`;
  }

  function middle(contextName, statusHtml, metaHtml) {
    return `<div class="cmid">
      <div class="ctx-wrap"><span class="ctx-tag">context</span><span class="ctx-name">${esc(contextName || '—')}</span></div>
      <div class="cmeta">${statusHtml}${metaHtml ? ' · ' + metaHtml : ''}</div>
    </div>`;
  }

  function panelsHtml(model, hot) {
    const byCp = {};
    model.connections.forEach((c) => (byCp[c.profile] || (byCp[c.profile] = { conns: [], unbound: [] })).conns.push(c));
    model.unbound.forEach((u) => (byCp[u.profile] || (byCp[u.profile] = { conns: [], unbound: [] })).unbound.push(u));

    return Object.keys(byCp).sort().map((profile) => {
      const g = byCp[profile];
      const reg = regFor(profile);
      if (reg === undefined) ensureProfile(profile);
      const title = reg ? esc(reg.title || '') : (reg === null ? 'not in registry' : '');

      const conns = g.conns.map((c) => {
        const n = Object.keys(c.props).length;
        const chg = hot.has(c.id);
        const bound = `<span class="chip bound"><span class="c-dot"></span>Bound</span>`;
        const meta = `${n} propert${n === 1 ? 'y' : 'ies'}${chg ? ' · <span class="upd">updated</span>' : ''}`;
        return `<div class="conn ${state.expanded.has(c.id) ? 'open' : ''} ${chg ? 'hot' : ''}" data-k="${esc(c.id)}">
          <div class="crow">
            ${party(c.provider, 'provider')}
            ${middle(c.provider.context, bound, meta)}
            ${party(c.consumer, 'consumer')}
            <div class="chev">▶</div>
          </div>
          <div class="details">${propTable(c.profile, c.props, c.id, prevVals)}</div>
        </div>`;
      }).join('');

      const ub = g.unbound.map((u) => {
        const key = 'ub-' + u.at.path + '-' + u.role;
        const n = Object.keys(u.props).length;
        const chip = `<span class="chip unbound"><span class="c-dot"></span>Awaiting broker</span>`;
        const meta = `${n} declared propert${n === 1 ? 'y' : 'ies'}`;
        return `<div class="conn unbound ${state.expanded.has(key) ? 'open' : ''}" data-k="${esc(key)}">
          <div class="crow">
            ${u.role === 'provider' ? party(u.at, 'provider') : party(null, 'provider')}
            ${middle(u.at.context, chip, meta)}
            ${u.role === 'consumer' ? party(u.at, 'consumer') : party(null, 'consumer')}
            <div class="chev">▶</div>
          </div>
          <div class="details">${propTable(u.profile, u.props, null, prevVals)}</div>
        </div>`;
      }).join('');

      const cnt = g.conns.length + g.unbound.length;
      return `<div class="group"><div class="group-head"><span class="cp">${esc(profile)}</span>
        <span class="title">${title}</span><span class="count">${cnt} ${cnt === 1 ? 'entry' : 'entries'}</span></div>
        <div class="conns">${conns}${ub}</div></div>`;
    }).join('');
  }

  function render() {
    const model = parseKeys(getKeys());
    const connected = Object.keys(getKeys()).length > 0;

    // Which connections had a property value change vs the previous snapshot?
    // (Only when we already had a prior value — so initial load never highlights.)
    const now = Date.now();
    model.connections.forEach((cn) => {
      for (const p in cn.props) {
        const k = cn.id + '|' + p;
        if (prevVals[k] !== undefined && prevVals[k] !== cn.props[p]) { lastChanged[cn.id] = now; break; }
      }
    });
    // "hot" = changed within the last HOLD_MS. Held via state so it persists
    // across re-renders; a timer forces one more render to clear it.
    const hot = new Set();
    model.connections.forEach((cn) => { if (lastChanged[cn.id] && now - lastChanged[cn.id] < HOLD_MS) hot.add(cn.id); });
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (hot.size) holdTimer = setTimeout(render, HOLD_MS + 30);

    const body = connected
      ? (model.connections.length + model.unbound.length ? panelsHtml(model, hot) : `<div class="m-empty">Connected, but no provider/consumer capabilities are declared yet.</div>`)
      : `<div class="m-empty">Not connected to a realm.<br>Open the <button class="go-config">Config</button> tab and Connect to see connections here.</div>`;

    root.innerHTML = `<div class="m-view">${body}</div>`;

    root.querySelectorAll('.conn .crow').forEach((r) => r.addEventListener('click', () => {
      const el = r.parentElement, k = el.dataset.k;
      if (state.expanded.has(k)) state.expanded.delete(k); else state.expanded.add(k);
      el.classList.toggle('open');
    }));

    const nv = {};
    model.connections.forEach((cn) => { for (const p in cn.props) nv[cn.id + '|' + p] = cn.props[p]; });
    prevVals = nv;
  }

  onChange(render);
  render();
})();
