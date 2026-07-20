// monitor.js — the Monitor view, a drill-down over the realm:
//   realm   : grid of system cards
//   system  : two tile sets — NODE tiles (contexts+connections counts) and
//             CONTEXT tiles (nodes+connections counts), visually distinct
//   node    : full page for one node (its contexts › capabilities)
//   context : full page for one context (the nodes declaring it › capabilities)
// Capability rows expand to the shared property table; peer links jump to the
// peer's system page. Consumes AreteModel; applies no CP semantics.
(function () {
  const root = document.getElementById('monitor-root');
  if (!root || !window.AreteModel) return;
  const { esc, parseKeys, getKeys, onChange, propTable } = window.AreteModel;

  // view = {kind:'realm'} | {kind:'system',sysId} | {kind:'node',sysId,nodeId} | {kind:'context',sysId,ctxId}
  let view = { kind: 'realm' };
  const expandedCaps = new Set(); // ck = ctxPath|role|profile
  let crumbViews = [];            // views bound to crumb links, per render

  // ---- assemble a system-centric structure from raw keys + parsed model ----
  function buildSystems(keys, model) {
    const nameOf = model.nameOf;
    const sys = {};
    for (const key in keys) {
      const m = key.match(/^cns\/([^/]+)(?:\/nodes\/([^/]+)(?:\/contexts\/([^/]+))?)?/);
      if (!m) continue;
      const [, sid, nid, cid] = m;
      const S = sys[sid] || (sys[sid] = {
        id: sid, name: nameOf['cns/' + sid] || sid,
        orchestrator: keys['cns/' + sid + '/orchestrator'] || '', nodes: {},
      });
      if (!nid) continue;
      const N = S.nodes[nid] || (S.nodes[nid] = {
        id: nid, name: nameOf['cns/' + sid + '/nodes/' + nid] || nid,
        upstream: String(keys['cns/' + sid + '/nodes/' + nid + '/upstream'] || '').toLowerCase() === 'true',
        ctxs: {},
      });
      if (!cid) continue;
      N.ctxs[cid] || (N.ctxs[cid] = {
        id: cid, name: nameOf['cns/' + sid + '/nodes/' + nid + '/contexts/' + cid] || cid, caps: [],
      });
    }
    for (const ck in model.caps) {
      const cap = model.caps[ck];
      const p = cap.ctxPath.split('/');
      const S = sys[p[1]], N = S && S.nodes[p[3]], C = N && N.ctxs[p[5]];
      if (!C) continue;
      const connIds = Object.keys(cap.conns);
      const peers = connIds.map((id) => cap.conns[id].peer).filter(Boolean).map((path) => model.label(path));
      C.caps.push({ ck, profile: cap.profile, role: cap.role, props: cap.props, nProps: Object.keys(cap.props).length, bound: connIds.length > 0, connIds, peers });
    }
    const connCount = {};
    model.connections.forEach((c) => {
      new Set([c.provider.sysId, c.consumer && c.consumer.sysId].filter(Boolean))
        .forEach((sid) => { connCount[sid] = (connCount[sid] || 0) + 1; });
    });
    return { list: Object.values(sys).sort((a, b) => a.name.localeCompare(b.name)), connCount };
  }

  // per-system aggregates for the tile sets
  function sysAgg(S) {
    const nodes = Object.values(S.nodes).sort((a, b) => a.name.localeCompare(b.name));
    const nodeAgg = nodes.map((N) => {
      const conn = new Set();
      Object.values(N.ctxs).forEach((C) => C.caps.forEach((cap) => cap.connIds.forEach((i) => conn.add(i))));
      return { N, ctxN: Object.keys(N.ctxs).length, connN: conn.size };
    });
    const ctxMap = {};
    nodes.forEach((N) => Object.values(N.ctxs).forEach((C) => {
      const A = ctxMap[C.id] || (ctxMap[C.id] = { id: C.id, name: C.name, nodeIds: new Set(), connIds: new Set() });
      if (A.name === A.id && C.name !== C.id) A.name = C.name;
      A.nodeIds.add(N.id);
      C.caps.forEach((cap) => cap.connIds.forEach((i) => A.connIds.add(i)));
    }));
    const ctxAgg = Object.values(ctxMap).sort((a, b) => a.name.localeCompare(b.name));
    return { nodeAgg, ctxAgg };
  }

  // ---- shared fragments ----
  function crumbHtml(parts) {
    crumbViews = parts.map((p) => p.view || null);
    return `<div class="crumbs">${parts.map((p, i) =>
      p.view
        ? `<button class="crumb-lnk" data-i="${i}">${esc(p.label)}</button><span class="crumb-sep">›</span>`
        : `<span class="crumb-cur">${esc(p.label)}</span>`
    ).join('')}</div>`;
  }

  function capRowHtml(cap) {
    const open = expandedCaps.has(cap.ck);
    const roleCls = cap.role === 'provider' ? 'prov' : 'cons';
    const peers = cap.bound
      ? cap.peers.map((pl) => `<button class="peer-link" data-sys="${esc(pl.sysId)}" title="open ${esc(pl.system)}">${esc(pl.system)} · ${esc(pl.node)}</button>`).join(', ')
      : '<span class="awaitl">awaiting broker</span>';
    return `<div class="cap-wrap">
      <div class="cap-row ${open ? 'open' : ''}" data-ck="${esc(cap.ck)}">
        <span class="cap-chev">${open ? '▾' : '▸'}</span>
        <span class="cap-prof">${esc(cap.profile)}</span>
        <span class="cap-role ${roleCls}">${cap.role}</span>
        <span class="cap-meta">${cap.nProps} prop${cap.nProps === 1 ? '' : 's'} · ${cap.bound ? '⇄ ' : ''}${peers}</span>
      </div>
      ${open ? `<div class="cap-details">${propTable(cap.profile, cap.props, null, {})}</div>` : ''}
    </div>`;
  }

  // ---- pages ----
  function realmHtml(list, connCount) {
    const cards = list.map((S) => {
      const nodes = Object.values(S.nodes);
      const ctxIds = new Set(); nodes.forEach((N) => Object.keys(N.ctxs).forEach((c) => ctxIds.add(c)));
      const conns = connCount[S.id] || 0;
      return `<div class="sys-card" data-sys="${esc(S.id)}" role="button" tabindex="0">
        <div class="sname">${esc(S.name)}</div>
        <div class="sid">${esc(S.id)}</div>
        <div class="scounts">
          <span><b>${nodes.length}</b> node${nodes.length === 1 ? '' : 's'}</span>
          <span><b>${ctxIds.size}</b> context${ctxIds.size === 1 ? '' : 's'}</span>
          <span><b>${conns}</b> connection${conns === 1 ? '' : 's'}</span>
        </div>
      </div>`;
    }).join('');
    return `<div class="sys-grid">${cards}</div>`;
  }

  function systemHtml(S, connCount) {
    const { nodeAgg, ctxAgg } = sysAgg(S);
    const conns = connCount[S.id] || 0;
    const nodeTiles = nodeAgg.map(({ N, ctxN, connN }) => `
      <div class="node-tile" data-node="${esc(N.id)}" role="button" tabindex="0">
        <div class="t-kind">node${N.upstream ? ' · upstream' : ''}</div>
        <div class="t-name">${esc(N.name)}</div>
        <div class="t-id">${esc(N.id)}</div>
        <div class="t-counts"><span><b>${ctxN}</b> context${ctxN === 1 ? '' : 's'}</span><span><b>${connN}</b> connection${connN === 1 ? '' : 's'}</span></div>
      </div>`).join('') || '<div class="none-note">no nodes</div>';
    const ctxTiles = ctxAgg.map((A) => `
      <div class="ctx-tile" data-ctx="${esc(A.id)}" role="button" tabindex="0">
        <div class="t-kind">context</div>
        <div class="t-name">${esc(A.name)}</div>
        <div class="t-id">${esc(A.id)}</div>
        <div class="t-counts"><span><b>${A.nodeIds.size}</b> node${A.nodeIds.size === 1 ? '' : 's'}</span><span><b>${A.connIds.size}</b> connection${A.connIds.size === 1 ? '' : 's'}</span></div>
      </div>`).join('') || '<div class="none-note">no contexts</div>';

    return `
      ${crumbHtml([{ label: 'All systems', view: { kind: 'realm' } }, { label: S.name }])}
      <div class="sys-sub pagehead">${esc(S.id)}${S.orchestrator ? ' · orchestrator: ' + esc(S.orchestrator) : ''} · ${conns} connection${conns === 1 ? '' : 's'}</div>
      <div class="sec-label">Nodes <span class="sec-n">${nodeAgg.length}</span></div>
      <div class="tile-grid">${nodeTiles}</div>
      <div class="sec-label">Contexts <span class="sec-n">${ctxAgg.length}</span></div>
      <div class="tile-grid">${ctxTiles}</div>`;
  }

  function nodeHtml(S, N) {
    const ctxs = Object.values(N.ctxs).sort((a, b) => a.name.localeCompare(b.name));
    const blocks = ctxs.map((C) => `
      <div class="ctx-block">
        <div class="ctx-title">${esc(C.name)} <span class="tagl">context</span> <span class="idl">${esc(C.id)}</span></div>
        ${C.caps.map(capRowHtml).join('') || '<div class="none-note">no capabilities declared</div>'}
      </div>`).join('') || '<div class="ctx-block"><div class="none-note">no contexts</div></div>';
    return `
      ${crumbHtml([{ label: 'All systems', view: { kind: 'realm' } }, { label: S.name, view: { kind: 'system', sysId: S.id } }, { label: N.name }])}
      <div class="sys-sub pagehead">node ${esc(N.id)}${N.upstream ? ' · upstream' : ''} · system ${esc(S.name)}</div>
      <div class="node-card">${blocks}</div>`;
  }

  function contextHtml(S, ctxId) {
    const holders = Object.values(S.nodes)
      .filter((N) => N.ctxs[ctxId])
      .sort((a, b) => a.name.localeCompare(b.name));
    const name = holders.length ? holders.map((N) => N.ctxs[ctxId].name).find((n) => n !== ctxId) || ctxId : ctxId;
    const blocks = holders.map((N) => `
      <div class="ctx-block">
        <div class="ctx-title"><button class="node-link" data-node="${esc(N.id)}">${esc(N.name)}</button> <span class="tagl">node${N.upstream ? ' · upstream' : ''}</span> <span class="idl">${esc(N.id)}</span></div>
        ${N.ctxs[ctxId].caps.map(capRowHtml).join('') || '<div class="none-note">no capabilities declared</div>'}
      </div>`).join('') || '<div class="ctx-block"><div class="none-note">no nodes declare this context</div></div>';
    return `
      ${crumbHtml([{ label: 'All systems', view: { kind: 'realm' } }, { label: S.name, view: { kind: 'system', sysId: S.id } }, { label: name }])}
      <div class="sys-sub pagehead">context ${esc(ctxId)} · declared by ${holders.length} node${holders.length === 1 ? '' : 's'} in ${esc(S.name)}</div>
      <div class="node-card">${blocks}</div>`;
  }

  // ---- render ----
  function render() {
    const keys = getKeys();
    const connected = Object.keys(keys).length > 0;
    const model = parseKeys(keys);
    const { list, connCount } = buildSystems(keys, model);
    const findSys = (id) => list.find((s) => s.id === id);

    let body;
    if (!connected) {
      body = `<div class="m-empty">Not connected to a realm.<br>Open the <button class="go-config">Config</button> tab and Connect to see the realm's systems here.</div>`;
      view = { kind: 'realm' };
    } else if (view.kind === 'system') {
      const S = findSys(view.sysId);
      body = S ? systemHtml(S, connCount) : ((view = { kind: 'realm' }), realmHtml(list, connCount));
    } else if (view.kind === 'node') {
      const S = findSys(view.sysId); const N = S && S.nodes[view.nodeId];
      body = N ? nodeHtml(S, N) : S ? ((view = { kind: 'system', sysId: S.id }), systemHtml(S, connCount)) : ((view = { kind: 'realm' }), realmHtml(list, connCount));
    } else if (view.kind === 'context') {
      const S = findSys(view.sysId);
      const has = S && Object.values(S.nodes).some((N) => N.ctxs[view.ctxId]);
      body = has ? contextHtml(S, view.ctxId) : S ? ((view = { kind: 'system', sysId: S.id }), systemHtml(S, connCount)) : ((view = { kind: 'realm' }), realmHtml(list, connCount));
    } else {
      body = realmHtml(list, connCount);
    }

    root.innerHTML = `<div class="m-view">${body}</div>`;

    // wiring
    const nav = (v) => { view = v; render(); };
    const press = (el, go) => {
      el.addEventListener('click', go);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    };
    root.querySelectorAll('.sys-card').forEach((el) => press(el, () => nav({ kind: 'system', sysId: el.dataset.sys })));
    root.querySelectorAll('.node-tile').forEach((el) => press(el, () => nav({ kind: 'node', sysId: view.sysId, nodeId: el.dataset.node })));
    root.querySelectorAll('.ctx-tile').forEach((el) => press(el, () => nav({ kind: 'context', sysId: view.sysId, ctxId: el.dataset.ctx })));
    root.querySelectorAll('.crumb-lnk').forEach((el) => el.addEventListener('click', () => { const v = crumbViews[Number(el.dataset.i)]; if (v) nav(v); }));
    root.querySelectorAll('.node-link').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); nav({ kind: 'node', sysId: view.sysId, nodeId: el.dataset.node }); }));
    root.querySelectorAll('.cap-row').forEach((el) => el.addEventListener('click', (e) => {
      if (e.target.closest('.peer-link')) return;
      const ck = el.dataset.ck;
      if (expandedCaps.has(ck)) expandedCaps.delete(ck); else expandedCaps.add(ck);
      render();
    }));
    root.querySelectorAll('.peer-link').forEach((el) => el.addEventListener('click', (e) => {
      e.stopPropagation();
      nav({ kind: 'system', sysId: el.dataset.sys });
    }));
  }

  // cross-tab navigation (e.g. from the Graph): jump straight to a page here
  window.addEventListener('arete:nav-monitor', (e) => {
    view = e.detail || { kind: 'realm' };
    render();
    const t = document.getElementById('tab-monitor');
    if (t) t.click();
  });

  onChange(render);
  render();
})();
