// arete-model.js — SHARED data layer for all monitor-style views.
// Owns the single live `client.keys` subscription, the CP registry cache, the
// structural parse, and the property-table renderer. Views (monitor.js,
// connections.js, …) consume this via window.AreteModel and never talk to the
// bridge or duplicate parsing. This is the "one data layer, many views" seam.
window.AreteModel = (function () {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  // ---- live keys store ----
  let keys = {};
  const listeners = new Set();
  function notify() { listeners.forEach((cb) => { try { cb(keys); } catch (_) {} }); }
  function onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }
  function getKeys() { return keys; }

  // ---- CP registry (tier-2 enrichment), fetched in main, cached here ----
  const registry = {};          // name -> {title, props} | null ; undefined = not yet requested
  const requested = new Set();
  function regFor(name) { return registry[name]; }
  function parseProfile(p) {
    if (!p || !Array.isArray(p.versions) || !p.versions.length) return null;
    const latest = p.versions[p.versions.length - 1] || {};
    const props = {};
    (latest.properties || []).forEach((pr) => {
      props[pr.name] = { role: 'server' in pr ? 'server' : 'client', desc: pr.description || '' };
    });
    return { title: p.title || '', props };
  }
  function ensureProfile(name) {
    if (requested.has(name) || !window.arete) return;
    requested.add(name);
    window.arete.getProfile(name)
      .then((p) => { registry[name] = parseProfile(p); notify(); })
      .catch(() => { registry[name] = null; });
  }

  // ---- pure structural parse of client.keys (no CP semantics) ----
  function parseKeys(k) {
    const nameOf = {};
    for (const key in k) if (key.endsWith('/name')) nameOf[key.slice(0, -5)] = k[key];
    const label = (ctxPath) => {
      const p = ctxPath.split('/');
      return {
        system: nameOf[p.slice(0, 2).join('/')] || p[1],
        node: nameOf[p.slice(0, 4).join('/')] || p[3],
        context: nameOf[ctxPath] || p[5],
        path: ctxPath, sysId: p[1], nodeId: p[3], ctxId: p[5],
      };
    };
    const caps = {};
    const RE = /^(cns\/[^/]+\/nodes\/[^/]+\/contexts\/[^/]+)\/(provider|consumer)\/([^/]+)\/(.*)$/;
    for (const key in k) {
      const m = key.match(RE);
      if (!m) continue;
      const [, ctxPath, role, profile, rest] = m;
      const ck = ctxPath + '|' + role + '|' + profile;
      const cap = caps[ck] || (caps[ck] = { role, profile, ctxPath, props: {}, conns: {} });
      let mm;
      if ((mm = rest.match(/^properties\/(.+)$/))) cap.props[mm[1]] = k[key];
      else if ((mm = rest.match(/^connections\/([^/]+)\/(consumer|provider)$/))) (cap.conns[mm[1]] || (cap.conns[mm[1]] = { props: {} })).peer = k[key];
      else if ((mm = rest.match(/^connections\/([^/]+)\/properties\/(.+)$/))) (cap.conns[mm[1]] || (cap.conns[mm[1]] = { props: {} })).props[mm[2]] = k[key];
    }
    const connections = [], bound = new Set();
    for (const ck in caps) {
      const cap = caps[ck];
      const ids = Object.keys(cap.conns);
      if (ids.length) bound.add(ck);
      if (cap.role !== 'provider') continue;
      for (const id of ids) {
        const peer = cap.conns[id].peer;
        if (peer) bound.add(peer + '|consumer|' + cap.profile);
        connections.push({ profile: cap.profile, id, provider: label(cap.ctxPath), consumer: peer ? label(peer) : null, props: cap.conns[id].props });
      }
    }
    const unbound = [];
    for (const ck in caps) {
      if (bound.has(ck) || Object.keys(caps[ck].conns).length) continue;
      const cap = caps[ck];
      unbound.push({ profile: cap.profile, role: cap.role, at: label(cap.ctxPath), props: cap.props });
    }
    // Entity counts come from the FULL namespace — every registered system,
    // node, and context (same derivation as the Home view's buildSystems) —
    // NOT just capability-bearing ones, so a realm of registered nodes with no
    // active capabilities still counts. Capabilities/providers/consumers are
    // inherently capability-derived and stay sourced from caps.
    const systems = new Set(), nodes = new Set(), contexts = new Set();
    for (const key in k) {
      const m = key.match(/^cns\/([^/]+)(?:\/nodes\/([^/]+)(?:\/contexts\/([^/]+))?)?/);
      if (!m) continue;
      const [, sid, nid, cid] = m;
      systems.add(sid);
      if (nid) nodes.add(sid + '/' + nid);
      if (cid) contexts.add(sid + '/' + nid + '/' + cid);
    }
    let providers = 0, consumers = 0;
    for (const ck in caps) {
      if (caps[ck].role === 'provider') providers++; else consumers++;
    }
    return {
      caps, connections, unbound, nameOf, label,
      counts: {
        systems: systems.size, nodes: nodes.size, contexts: contexts.size,
        capabilities: Object.keys(caps).length, providers, consumers,
        connections: connections.length, unbound: unbound.length,
      },
    };
  }

  // ---- property table (shared by any view that expands a capability/connection) ----
  // flashPrefix + prevVals enable value-change flashing; pass prevVals={} to disable.
  function propTable(profile, props, flashPrefix, prevVals) {
    const reg = registry[profile];
    if (reg === undefined) ensureProfile(profile);
    const names = Object.keys(props);
    let order = names;
    if (reg && reg.props) { const ro = Object.keys(reg.props); order = [...ro.filter((n) => names.includes(n)), ...names.filter((n) => !ro.includes(n))]; }
    const rows = order.map((n) => {
      const raw = props[n];
      const r = reg && reg.props && reg.props[n];
      // Data-flow arrow matches the panel layout (provider left, consumer right):
      // provider writes → data flows left-to-right; consumer writes ← right-to-left.
      const flow = r
        ? (r.role === 'server'
            ? '<span class="fl prov" title="provider writes — flows provider → consumer">──▶</span>'
            : '<span class="fl cons" title="consumer writes — flows consumer → provider">◀──</span>')
        : '<span class="fl unk" title="direction unknown — profile not in registry">—</span>';
      const desc = r && r.desc ? `<div class="pdesc">${esc(r.desc)}</div>` : '';
      const empty = raw === '' || raw == null;
      const val = empty ? '<span class="pval empty">— (empty)</span>' : `<span class="pval">${esc(raw)}</span>`;
      const fk = flashPrefix ? flashPrefix + '|' + n : null;
      const changed = fk && prevVals && prevVals[fk] !== undefined && prevVals[fk] !== raw;
      return `<tr><td><div class="pname">${esc(n)}</div>${desc}</td><td>${flow}</td><td class="${changed ? 'flash' : ''}">${val}</td></tr>`;
    }).join('');
    return `<table class="props"><thead><tr><th>Property</th><th>Flow</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // ---- init the single live subscription ----
  if (window.arete) {
    window.arete.onKeys((k) => { keys = k || {}; notify(); });
    window.arete.getKeys().then((k) => { keys = k || {}; notify(); }).catch(() => {});
  }

  return { esc, onChange, getKeys, parseKeys, propTable, ensureProfile, regFor };
})();
