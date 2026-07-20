// contexts.js — the Contexts view: the realm's contexts as first-class venues.
// Realm-wide: one entry per context ID, aggregated across every system that
// declares it. Headline name = the most common name variant (contexts can be
// named differently by different systems); variants shown beneath.
// Connected contexts listed first; declaration-only (awaiting broker) contexts
// in a muted secondary section. Consumes AreteModel; applies no CP semantics.
(function () {
  const root = document.getElementById('contexts-root');
  if (!root || !window.AreteModel) return;
  const { esc, parseKeys, getKeys, onChange, propTable } = window.AreteModel;

  // view = {kind:'list'} | {kind:'ctx', ctxId}
  let view = { kind: 'list' };
  const expanded = new Set(); // 'c:'+connId or 'k:'+ck
  let crumbViews = [];

  // ---- realm-wide aggregation by context ID ----
  function buildCtxAgg(keys, model) {
    const map = {};
    // discover every declared context path (even ones with no capabilities)
    const ctxPaths = new Set();
    for (const key in keys) {
      const m = key.match(/^(cns\/[^/]+\/nodes\/[^/]+\/contexts\/[^/]+)(\/|$)/);
      if (m) ctxPaths.add(m[1]);
    }
    ctxPaths.forEach((path) => {
      const p = path.split('/');
      const id = p[5];
      const A = map[id] || (map[id] = {
        id, names: {}, systems: new Set(), nodes: new Set(),
        profiles: new Set(), connIds: new Set(), caps: [], unbound: 0,
      });
      const nm = model.nameOf[path] || id;
      A.names[nm] = (A.names[nm] || 0) + 1;
      A.systems.add(p[1]);
      A.nodes.add(p[1] + '/' + p[3]);
    });
    // attach capabilities
    for (const ck in model.caps) {
      const cap = model.caps[ck];
      const p = cap.ctxPath.split('/');
      const A = map[p[5]];
      if (!A) continue;
      const connIds = Object.keys(cap.conns);
      connIds.forEach((i) => A.connIds.add(i));
      if (!connIds.length) A.unbound++;
      A.profiles.add(cap.profile);
      A.caps.push({
        ck, profile: cap.profile, role: cap.role, props: cap.props,
        nProps: Object.keys(cap.props).length, bound: connIds.length > 0,
        at: model.label(cap.ctxPath),
        peers: connIds.map((i) => cap.conns[i].peer).filter(Boolean).map((path) => model.label(path)),
      });
    }
    // headline name: most common variant; ties broken alphabetically
    Object.values(map).forEach((A) => {
      const entries = Object.entries(A.names).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
      A.headline = entries.length ? entries[0][0] : A.id;
      A.variants = entries.map(([n]) => n).filter((n) => n !== A.headline && n !== A.id);
    });
    return Object.values(map).sort((a, b) => a.headline.localeCompare(b.headline));
  }

  function crumbHtml(parts) {
    crumbViews = parts.map((p) => p.view || null);
    return `<div class="crumbs">${parts.map((p, i) =>
      p.view ? `<button class="crumb-lnk" data-i="${i}">${esc(p.label)}</button><span class="crumb-sep">›</span>`
             : `<span class="crumb-cur">${esc(p.label)}</span>`).join('')}</div>`;
  }

  // ---- list level ----
  function tileHtml(A) {
    const variants = A.variants.length ? `<div class="t-variants">also: ${A.variants.map(esc).join(', ')}</div>` : '';
    const cps = A.profiles.size;
    return `<div class="ctx-tile" data-ctx="${esc(A.id)}" role="button" tabindex="0">
      <div class="t-kind">context</div>
      <div class="t-name">${esc(A.headline)}</div>
      ${variants}
      <div class="t-id">${esc(A.id)}</div>
      <div class="t-counts">
        <span><b>${A.systems.size}</b> system${A.systems.size === 1 ? '' : 's'}</span>
        <span><b>${A.nodes.size}</b> node${A.nodes.size === 1 ? '' : 's'}</span>
        <span><b>${A.connIds.size}</b> connection${A.connIds.size === 1 ? '' : 's'}</span>
        <span><b>${cps}</b> CP${cps === 1 ? '' : 's'}</span>
      </div>
    </div>`;
  }

  function listHtml(aggs) {
    const connectedC = aggs.filter((A) => A.connIds.size > 0);
    const idleC = aggs.filter((A) => A.connIds.size === 0);
    let html = '';
    html += `<div class="sec-label">Contexts with connections <span class="sec-n">${connectedC.length}</span></div>`;
    html += connectedC.length
      ? `<div class="tile-grid">${connectedC.map(tileHtml).join('')}</div>`
      : `<div class="none-note">none yet</div>`;
    if (idleC.length) {
      html += `<div class="sec-label">Declarations only — awaiting broker <span class="sec-n">${idleC.length}</span></div>`;
      html += `<div class="tile-grid muted-sec">${idleC.map(tileHtml).join('')}</div>`;
    }
    return html;
  }

  // ---- detail level ----
  function connPanelHtml(c) {
    const key = 'c:' + c.id;
    const open = expanded.has(key);
    const n = Object.keys(c.props).length;
    const party = (l, role) => l
      ? `<div class="cparty ${role}"><div class="pty-sys">${esc(l.system)}</div><div class="pty-node">${esc(l.node)}</div><div class="pty-role">${role}</div></div>`
      : `<div class="cparty ${role} empty-side"><span class="chip unbound"><span class="c-dot"></span>awaiting ${role}</span></div>`;
    return `<div class="conn ${open ? 'open' : ''}" data-x="${esc(key)}">
      <div class="crow">
        ${party(c.provider, 'provider')}
        <div class="cmid">
          <div class="ctx-wrap"><span class="ctx-tag">cp</span><span class="ctx-name">${esc(c.profile)}</span></div>
          <div class="cmeta"><span class="chip bound"><span class="c-dot"></span>Bound</span> · ${n} propert${n === 1 ? 'y' : 'ies'}</div>
        </div>
        ${party(c.consumer, 'consumer')}
        <div class="chev">▶</div>
      </div>
      <div class="details">${propTable(c.profile, c.props, null, {})}</div>
    </div>`;
  }

  function capRowHtml(cap) {
    const key = 'k:' + cap.ck;
    const open = expanded.has(key);
    const roleCls = cap.role === 'provider' ? 'prov' : 'cons';
    const peers = cap.bound
      ? cap.peers.map((pl) => `${esc(pl.system)} · ${esc(pl.node)}`).join(', ')
      : '<span class="awaitl">awaiting broker</span>';
    return `<div class="cap-wrap">
      <div class="cap-row ${open ? 'open' : ''}" data-x="${esc(key)}">
        <span class="cap-chev">${open ? '▾' : '▸'}</span>
        <span class="cap-prof">${esc(cap.profile)}</span>
        <span class="cap-role ${roleCls}">${cap.role}</span>
        <span class="cap-meta">${cap.nProps} prop${cap.nProps === 1 ? '' : 's'} · ${cap.bound ? '⇄ ' : ''}${peers}</span>
      </div>
      ${open ? `<div class="cap-details">${propTable(cap.profile, cap.props, null, {})}</div>` : ''}
    </div>`;
  }

  function detailHtml(A, model) {
    const conns = model.connections.filter((c) =>
      c.provider.ctxId === A.id || (c.consumer && c.consumer.ctxId === A.id));

    // declared capabilities grouped by system › node
    const bySys = {};
    A.caps.forEach((cap) => {
      const s = cap.at.system, n = cap.at.node;
      ((bySys[s] || (bySys[s] = {}))[n] || (bySys[s][n] = [])).push(cap);
    });
    const capBlocks = Object.keys(bySys).sort().map((s) =>
      Object.keys(bySys[s]).sort().map((n) => `
        <div class="ctx-block">
          <div class="ctx-title">${esc(s)} <span class="crumb-sep">›</span> ${esc(n)} <span class="tagl">node</span></div>
          ${bySys[s][n].map(capRowHtml).join('')}
        </div>`).join('')
    ).join('');

    const variants = A.variants.length ? ` · also known as: ${A.variants.map(esc).join(', ')}` : '';
    return `
      ${crumbHtml([{ label: 'All contexts', view: { kind: 'list' } }, { label: A.headline }])}
      <div class="sys-sub pagehead">context ${esc(A.id)}${variants} · ${A.systems.size} system${A.systems.size === 1 ? '' : 's'} · ${A.nodes.size} node${A.nodes.size === 1 ? '' : 's'}</div>
      <div class="sec-label">Connections in this context <span class="sec-n">${conns.length}</span></div>
      ${conns.length ? `<div class="conns">${conns.map(connPanelHtml).join('')}</div>` : '<div class="none-note">none — declarations below are awaiting the broker</div>'}
      <div class="sec-label">Declared capabilities <span class="sec-n">${A.caps.length}</span></div>
      <div class="node-card">${capBlocks || '<div class="ctx-block"><div class="none-note">none</div></div>'}</div>`;
  }

  // ---- render ----
  function render() {
    const keys = getKeys();
    const connected = Object.keys(keys).length > 0;
    const model = parseKeys(keys);
    const aggs = buildCtxAgg(keys, model);

    let body;
    if (!connected) {
      body = `<div class="m-empty">Not connected to a realm.<br>Open the <button class="go-config">Config</button> tab and Connect to see the realm's contexts here.</div>`;
      view = { kind: 'list' };
    } else if (view.kind === 'ctx') {
      const A = aggs.find((x) => x.id === view.ctxId);
      body = A ? detailHtml(A, model) : ((view = { kind: 'list' }), listHtml(aggs));
    } else {
      body = listHtml(aggs);
    }

    root.innerHTML = `<div class="m-view">${body}</div>`;

    const nav = (v) => { view = v; render(); };
    root.querySelectorAll('.ctx-tile').forEach((el) => {
      const go = () => nav({ kind: 'ctx', ctxId: el.dataset.ctx });
      el.addEventListener('click', go);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
    root.querySelectorAll('.crumb-lnk').forEach((el) => el.addEventListener('click', () => { const v = crumbViews[Number(el.dataset.i)]; if (v) nav(v); }));
    root.querySelectorAll('[data-x]').forEach((el) => {
      const target = el.classList.contains('conn') ? el.querySelector('.crow') : el;
      target.addEventListener('click', () => {
        const k = el.dataset.x;
        if (expanded.has(k)) expanded.delete(k); else expanded.add(k);
        render();
      });
    });
  }

  // cross-tab navigation (e.g. from the Graph): open a context's detail page
  window.addEventListener('arete:nav-context', (e) => {
    view = { kind: 'ctx', ctxId: e.detail.ctxId };
    render();
    const t = document.getElementById('tab-contexts');
    if (t) t.click();
  });

  onChange(render);
  render();
})();
