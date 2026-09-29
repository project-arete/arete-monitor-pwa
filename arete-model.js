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
  // Keyed by name AND the version the realm recorded on the capability, so two
  // capabilities of one Profile at different versions never share an answer.
  //   registry[key] = { ok: true, title, props, roles, version, status }
  //                 | { ok: false, kind }     (why not: see electron/profiles.js)
  //                 | undefined               (not yet answered)
  // "registry unavailable" and the absences are asked again (RETRY_*), so a
  // Profile that is reachable or published later appears without a restart.
  const registry = {};
  const requested = new Set();
  const retryTimers = {};
  const RETRY_UNAVAILABLE_MS = 5000;
  const RETRY_ABSENT_MS = 30000;
  const keyOf = (name, version) => name + ':' + (version || '');
  function regFor(name, version) { return registry[keyOf(name, version)]; }
  function parseProfile(res) {
    if (!res || res.ok !== true || !res.profile) return { ok: false, kind: (res && res.kind) || 'registry unavailable' };
    const p = res.profile;
    const props = {};
    Object.keys(p.properties || {}).forEach((n) => {
      props[n] = { role: p.properties[n].role, desc: p.properties[n].description || '' };
    });
    return { ok: true, title: p.title || '', props, roles: p.roles || {}, version: p.version, status: p.status };
  }
  function scheduleRetry(name, version, ms) {
    const key = keyOf(name, version);
    if (retryTimers[key]) return;
    retryTimers[key] = setTimeout(() => {
      delete retryTimers[key];
      requested.delete(key);          // the failure stays on screen until a new answer replaces it
      ensureProfile(name, version);
    }, ms);
  }
  function ensureProfile(name, version) {
    const key = keyOf(name, version);
    if (requested.has(key) || !window.arete) return;
    requested.add(key);
    window.arete.getProfile(name, version || null)
      .then((res) => {
        const r = parseProfile(res);
        registry[key] = r;
        if (!r.ok) scheduleRetry(name, version, r.kind === 'registry unavailable' ? RETRY_UNAVAILABLE_MS : RETRY_ABSENT_MS);
        notify();
      })
      .catch(() => { registry[key] = { ok: false, kind: 'registry unavailable' }; scheduleRetry(name, version, RETRY_UNAVAILABLE_MS); notify(); });
  }
  // Why a Profile is not shown, in the words the views use
  function whyNot(reg) {
    if (!reg || reg.ok) return '';
    return ({
      'not registered': 'not registered',
      'nothing published': 'nothing published',
      'no such version': 'no such version',
      'deprecated': 'only deprecated versions',
      'registry unavailable': 'registry unavailable',
    })[reg.kind] || reg.kind;
  }
  // The recorded version, and a Deprecated mark when the registry says so
  const DEP_TITLE = 'Deprecated: existing Connections continue, but no new Connection forms at this version (spec 8.6)';
  function verLabel(profile, version) {
    const reg = regFor(profile, version);
    if (reg === undefined) ensureProfile(profile, version);
    const v = version ? `<span class="pver">v${esc(version)}</span>` : '';
    const dep = (reg && reg.ok && reg.status === 'deprecated') ? ` <span class="badge dep" title="${esc(DEP_TITLE)}">Deprecated</span>` : '';
    return v + dep;
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
      if (rest === 'version') cap.version = k[key];
      else if ((mm = rest.match(/^properties\/(.+)$/))) cap.props[mm[1]] = k[key];
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
        connections.push({ profile: cap.profile, version: cap.version, id, provider: label(cap.ctxPath), consumer: peer ? label(peer) : null, props: cap.conns[id].props });
      }
    }
    const unbound = [];
    for (const ck in caps) {
      if (bound.has(ck) || Object.keys(caps[ck].conns).length) continue;
      const cap = caps[ck];
      unbound.push({ profile: cap.profile, version: cap.version, role: cap.role, at: label(cap.ctxPath), props: cap.props });
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
  function propTable(profile, props, flashPrefix, prevVals, version) {
    const reg0 = regFor(profile, version);
    if (reg0 === undefined) ensureProfile(profile, version);
    const reg = (reg0 && reg0.ok) ? reg0 : null;   // a failure has no roles to show
    const names = Object.keys(props);
    let order = names;
    if (reg && reg.props) { const ro = Object.keys(reg.props); order = [...ro.filter((n) => names.includes(n)), ...names.filter((n) => !ro.includes(n))]; }
    const rows = order.map((n) => {
      const raw = props[n];
      const r = reg && reg.props && reg.props[n];
      // Data-flow arrow matches the panel layout (provider left, consumer right):
      // provider writes → data flows left-to-right; consumer writes ← right-to-left.
      const flow = r
        ? (r.role === 'provider'
            ? '<span class="fl prov" title="provider writes — flows provider → consumer">──▶</span>'
            : '<span class="fl cons" title="consumer writes — flows consumer → provider">◀──</span>')
        : `<span class="fl unk" title="direction unknown — ${esc(reg0 === undefined ? 'looking it up' : (whyNot(reg0) || 'profile not in registry'))}">—</span>`;
      const desc = r && r.desc ? `<div class="pdesc">${esc(r.desc)}</div>` : '';
      const empty = raw === '' || raw == null;
      const val = empty ? '<span class="pval empty">— (empty)</span>' : `<span class="pval">${esc(raw)}</span>`;
      const fk = flashPrefix ? flashPrefix + '|' + n : null;
      const changed = fk && prevVals && prevVals[fk] !== undefined && prevVals[fk] !== raw;
      return `<tr><td><div class="pname">${esc(n)}</div>${desc}</td><td>${flow}</td><td class="${changed ? 'flash' : ''}">${val}</td></tr>`;
    }).join('');
    const meta = reg0 === undefined ? ''
      : reg0.ok
        ? `<div class="pmeta"><span class="mono">cp:${esc(profile)}</span> · v${esc(reg0.version)}${reg0.roles && reg0.roles.provider ? ' · ' + esc(reg0.roles.provider) + ' ⇄ ' + esc(reg0.roles.consumer || '') : ''}${reg0.status === 'deprecated' ? ` <span class="badge dep" title="${esc(DEP_TITLE)}">Deprecated</span>` : ''}</div>`
        : `<div class="pmeta warn"><span class="mono">cp:${esc(profile)}</span>${version ? ' · v' + esc(version) : ''} · ${esc(whyNot(reg0))}${reg0.kind === 'registry unavailable' ? ' — retrying' : ''}</div>`;
    return `${meta}<table class="props"><thead><tr><th>Property</th><th>Flow</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // ---- init the single live subscription ----
  if (window.arete) {
    window.arete.onKeys((k) => { keys = k || {}; notify(); });
    window.arete.getKeys().then((k) => { keys = k || {}; notify(); }).catch(() => {});
  }

  return { esc, onChange, getKeys, parseKeys, propTable, ensureProfile, regFor, whyNot, verLabel };
})();
