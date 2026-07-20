// graph.js — the Graph view: the realm as a live knowledge graph.
// Vertices: NODES (blue circles, sized by capabilities) and CONTEXTS (violet
// diamonds, sized by connections). Edges: declarations (node → context; solid
// grey when the capability is bound, dashed when awaiting broker) and
// CONNECTIONS (provider node → consumer node; blue, animated flow, pulsing
// when a property value changes). Dependency-free force layout in SVG.
// Consumes AreteModel; applies no CP semantics.
(function () {
  const root = document.getElementById('graph-root');
  const panel = document.getElementById('panel-graph');
  if (!root || !panel || !window.AreteModel) return;
  const { esc, parseKeys, getKeys, onChange } = window.AreteModel;

  const W = 780, H = 560;                 // viewBox; scales responsively
  const pos = new Map();                  // vertex id -> {x,y,vx,vy,pin}
  let vertices = [], edges = [];          // current graph
  let svg = null, layer = {};             // svg + element handles per id
  let dragging = null, selected = null;
  let prevVals = {};                      // connId|prop -> value (change pulses)
  const hotUntil = new Map();             // connId -> timestamp
  let raf = 0;

  const short = (s, n = 18) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  // ---- build graph model from keys ----
  function buildGraph() {
    const keys = getKeys();
    const model = parseKeys(keys);
    const nameOf = model.nameOf;

    const verts = new Map(); // id -> vertex
    const nodeId = (sys, node) => 'n:' + sys + '/' + node;

    // node vertices (any node present in the namespace)
    for (const key in keys) {
      const m = key.match(/^cns\/([^/]+)\/nodes\/([^/]+)/);
      if (!m) continue;
      const id = nodeId(m[1], m[2]);
      if (!verts.has(id)) {
        verts.set(id, {
          id, kind: 'node',
          label: nameOf['cns/' + m[1] + '/nodes/' + m[2]] || m[2],
          sub: nameOf['cns/' + m[1]] || m[1],
          caps: 0, conns: 0,
        });
      }
    }
    // context vertices (realm-wide by ctx id) + name election (most common)
    const ctxNames = {};
    for (const key in keys) {
      const m = key.match(/^cns\/([^/]+)\/nodes\/([^/]+)\/contexts\/([^/]+)/);
      if (!m) continue;
      const cid = 'c:' + m[3];
      const nm = nameOf['cns/' + m[1] + '/nodes/' + m[2] + '/contexts/' + m[3]] || m[3];
      (ctxNames[cid] || (ctxNames[cid] = {}))[nm] = (ctxNames[cid][nm] || 0) + 1;
      if (!verts.has(cid)) verts.set(cid, { id: cid, kind: 'ctx', label: m[3], sub: 'context', caps: 0, conns: 0 });
    }
    Object.entries(ctxNames).forEach(([cid, names]) => {
      const best = Object.entries(names).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))[0];
      if (best) verts.get(cid).label = best[0];
    });

    // declaration edges (node→ctx), dedup + bound flag
    const decl = new Map(); // key -> {a,b,bound}
    for (const ck in model.caps) {
      const cap = model.caps[ck];
      const p = cap.ctxPath.split('/');
      const a = nodeId(p[1], p[3]), b = 'c:' + p[5];
      const k = a + '→' + b;
      const bound = Object.keys(cap.conns).length > 0;
      const d = decl.get(k) || { a, b, bound: false };
      d.bound = d.bound || bound;
      decl.set(k, d);
      const va = verts.get(a); if (va) va.caps++;
    }

    // connection edges (provider node → consumer node)
    const connEdges = [];
    const pairSeen = {};
    model.connections.forEach((c) => {
      if (!c.consumer) return;
      const a = nodeId(c.provider.sysId, c.provider.nodeId);
      const b = nodeId(c.consumer.sysId, c.consumer.nodeId);
      const pk = a + '→' + b;
      const idx = (pairSeen[pk] = (pairSeen[pk] || 0) + 1);
      connEdges.push({ kind: 'conn', a, b, id: c.id, profile: c.profile, idx });
      const va = verts.get(a), vb = verts.get(b);
      if (va) va.conns++;
      if (vb) vb.conns++;
      const vc = verts.get('c:' + c.provider.ctxId);
      if (vc) vc.conns++;
      // change detection for pulses
      for (const p in c.props) {
        const k = c.id + '|' + p;
        if (prevVals[k] !== undefined && prevVals[k] !== c.props[p]) hotUntil.set(c.id, Date.now() + 2600);
      }
    });
    const nv = {};
    model.connections.forEach((c) => { for (const p in c.props) nv[c.id + '|' + p] = c.props[p]; });
    prevVals = nv;

    vertices = [...verts.values()];
    edges = [
      ...[...decl.values()].map((d) => ({ kind: 'decl', a: d.a, b: d.b, bound: d.bound })),
      ...connEdges,
    ];

    // seed positions for new vertices (ring placement, deterministic-ish)
    vertices.forEach((v, i) => {
      if (!pos.has(v.id)) {
        const ang = (i / Math.max(1, vertices.length)) * Math.PI * 2;
        const r = v.kind === 'ctx' ? 60 : 190;
        pos.set(v.id, { x: W / 2 + r * Math.cos(ang), y: H / 2 + r * Math.sin(ang), vx: 0, vy: 0, pin: false });
      }
    });
    for (const id of [...pos.keys()]) if (!verts.has(id)) pos.delete(id);
  }

  // ---- physics ----
  function step() {
    const vs = vertices.map((v) => ({ v, p: pos.get(v.id) }));
    // pairwise repulsion
    for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) {
      const A = vs[i].p, B = vs[j].p;
      let dx = A.x - B.x, dy = A.y - B.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
      const f = 5200 / d2;
      const d = Math.sqrt(d2), fx = (dx / d) * f, fy = (dy / d) * f;
      A.vx += fx; A.vy += fy; B.vx -= fx; B.vy -= fy;
    }
    // springs
    edges.forEach((e) => {
      const A = pos.get(e.a), B = pos.get(e.b);
      if (!A || !B) return;
      const rest = e.kind === 'conn' ? 200 : 120;
      const kSpring = e.kind === 'conn' ? 0.012 : 0.02;
      const dx = B.x - A.x, dy = B.y - A.y;
      const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const f = kSpring * (d - rest);
      const fx = (dx / d) * f, fy = (dy / d) * f;
      A.vx += fx; A.vy += fy; B.vx -= fx; B.vy -= fy;
    });
    // gravity to center + integrate
    vs.forEach(({ p }) => {
      p.vx += (W / 2 - p.x) * 0.0035;
      p.vy += (H / 2 - p.y) * 0.0035;
      if (!p.pin) {
        p.vx *= 0.82; p.vy *= 0.82;
        p.x += Math.max(-14, Math.min(14, p.vx));
        p.y += Math.max(-14, Math.min(14, p.vy));
        p.x = Math.max(30, Math.min(W - 30, p.x));
        p.y = Math.max(34, Math.min(H - 44, p.y));
      } else { p.vx = 0; p.vy = 0; }
    });
  }

  // ---- geometry helpers ----
  function radius(v) { return v.kind === 'ctx' ? 13 + Math.min(10, v.conns * 3) : 11 + Math.min(9, v.caps * 3); }
  function edgePath(e) {
    const A = pos.get(e.a), B = pos.get(e.b);
    if (!A || !B) return '';
    if (e.kind === 'decl') return `M${A.x},${A.y} L${B.x},${B.y}`;
    // connection: curved, shortened to vertex edge so the arrowhead shows
    const va = vertices.find((v) => v.id === e.a), vb = vertices.find((v) => v.id === e.b);
    const ra = va ? radius(va) + 3 : 14, rb = vb ? radius(vb) + 7 : 18;
    let dx = B.x - A.x, dy = B.y - A.y;
    const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const ux = dx / d, uy = dy / d;
    const sx = A.x + ux * ra, sy = A.y + uy * ra;
    const ex = B.x - ux * rb, ey = B.y - uy * rb;
    const bend = 26 * (e.idx % 2 === 0 ? -1 : 1) * Math.ceil(e.idx / 2);
    const mx = (sx + ex) / 2 - uy * bend, my = (sy + ey) / 2 + ux * bend;
    return `M${sx},${sy} Q${mx},${my} ${ex},${ey}`;
  }

  // ---- DOM build (topology changes only; positions patched per frame) ----
  function buildDom() {
    const legend = `
      <div class="g-legend">
        <span><span class="lg-dot lg-node"></span> node</span>
        <span><span class="lg-dot lg-ctx"></span> context</span>
        <span><svg width="26" height="10"><path d="M1,5 L21,5" class="g-edge-conn"/><path d="M21,5 l-5,-3 v6 z" fill="#4c8bf5"/></svg> connection</span>
        <span><svg width="26" height="10"><path d="M1,5 L25,5" class="g-edge-decl dashed"/></svg> awaiting broker</span>
        <span class="g-hint">drag to arrange · click for details</span>
      </div>`;
    const empty = Object.keys(getKeys()).length === 0;
    root.innerHTML = empty
      ? `<div class="m-empty">Not connected to a realm.<br>Open the <button class="go-config">Config</button> tab and Connect to see the graph here.</div>`
      : `${legend}
         <div class="g-wrap">
           <svg id="g-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
             <defs>
               <marker id="g-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                 <path d="M0,0 L10,5 L0,10 z" fill="#4c8bf5"/>
               </marker>
             </defs>
             <g id="g-edges"></g>
             <g id="g-verts"></g>
           </svg>
           <div class="g-card" id="g-card" hidden></div>
         </div>`;
    if (empty) { svg = null; return; }
    svg = root.querySelector('#g-svg');
    const ge = root.querySelector('#g-edges');
    const gv = root.querySelector('#g-verts');
    layer = {};

    edges.forEach((e, i) => {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const key = e.kind + ':' + (e.id || e.a + '→' + e.b);
      if (e.kind === 'conn') {
        p.setAttribute('class', 'g-edge-conn flow');
        p.setAttribute('marker-end', 'url(#g-arrow)');
        const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        t.textContent = e.profile + ' · connection ' + e.id;
        p.appendChild(t);
      } else {
        p.setAttribute('class', 'g-edge-decl' + (e.bound ? '' : ' dashed'));
      }
      ge.appendChild(p);
      layer[key] = p;
    });

    vertices.forEach((v) => {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'g-vert ' + (v.kind === 'ctx' ? 'is-ctx' : 'is-node'));
      g.dataset.id = v.id;
      const r = radius(v);
      const shape = document.createElementNS('http://www.w3.org/2000/svg', v.kind === 'ctx' ? 'rect' : 'circle');
      if (v.kind === 'ctx') {
        shape.setAttribute('width', r * 1.7); shape.setAttribute('height', r * 1.7);
        shape.setAttribute('x', -r * 0.85); shape.setAttribute('y', -r * 0.85);
        shape.setAttribute('rx', 4);
        shape.setAttribute('transform', 'rotate(45)');
      } else {
        shape.setAttribute('r', r);
      }
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('y', r + 14);
      label.setAttribute('class', 'g-label');
      label.textContent = short(v.label);
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      t.textContent = `${v.label} (${v.sub})`;
      g.appendChild(shape); g.appendChild(label); g.appendChild(t);
      gv.appendChild(g);
      layer[v.id] = g;

      // interactions
      g.addEventListener('pointerdown', (ev) => {
        dragging = v.id;
        const p = pos.get(v.id); if (p) p.pin = true;
        g.setPointerCapture(ev.pointerId);
        ev.preventDefault();
      });
      g.addEventListener('pointermove', (ev) => {
        if (dragging !== v.id) return;
        const pt = svgPoint(ev);
        const p = pos.get(v.id);
        if (p && pt) { p.x = pt.x; p.y = pt.y; }
      });
      g.addEventListener('pointerup', () => { const p = pos.get(v.id); if (p) p.pin = false; dragging = null; });
      g.addEventListener('click', (ev) => { ev.stopPropagation(); showCard(v); });
      g.addEventListener('dblclick', (ev) => { ev.stopPropagation(); navTo(v); });
      g.addEventListener('pointerenter', () => highlight(v.id, true));
      g.addEventListener('pointerleave', () => highlight(v.id, false));
    });

    svg.addEventListener('click', () => hideCard());
  }

  function svgPoint(ev) {
    if (!svg) return null;
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    const m = svg.getScreenCTM();
    return m ? pt.matrixTransform(m.inverse()) : null;
  }

  function highlight(id, on) {
    edges.forEach((e) => {
      const key = e.kind + ':' + (e.id || e.a + '→' + e.b);
      const el = layer[key];
      if (!el) return;
      const touches = e.a === id || e.b === id;
      el.classList.toggle('dim', on && !touches);
      el.classList.toggle('lit', on && touches);
    });
  }

  // Navigate to the vertex's full page: node → Monitor node page; context →
  // Contexts detail page. Dispatched over a tiny cross-tab event bus.
  function navTo(v) {
    if (v.kind === 'node') {
      const rest = v.id.slice(2);
      const i = rest.indexOf('/');
      window.dispatchEvent(new CustomEvent('arete:nav-monitor', {
        detail: { kind: 'node', sysId: rest.slice(0, i), nodeId: rest.slice(i + 1) },
      }));
    } else {
      window.dispatchEvent(new CustomEvent('arete:nav-context', { detail: { ctxId: v.id.slice(2) } }));
    }
  }

  function showCard(v) {
    const card = root.querySelector('#g-card');
    if (!card) return;
    selected = v.id;
    const degConn = edges.filter((e) => e.kind === 'conn' && (e.a === v.id || e.b === v.id)).length;
    const degDecl = edges.filter((e) => e.kind === 'decl' && (e.a === v.id || e.b === v.id)).length;
    const actions = `<div class="gc-actions"><button class="gc-open">Open ${v.kind === 'ctx' ? 'context' : 'node'} page →</button></div>`;
    card.innerHTML = (v.kind === 'ctx'
      ? `<div class="gc-kind" style="color:#a99df0">context</div><div class="gc-name">${esc(v.label)}</div>
         <div class="gc-sub">${esc(v.id.slice(2))}</div>
         <div class="gc-counts">${v.conns} connection${v.conns === 1 ? '' : 's'} · ${degDecl} declaring node${degDecl === 1 ? '' : 's'}</div>`
      : `<div class="gc-kind" style="color:#8fb4f0">node</div><div class="gc-name">${esc(v.label)}</div>
         <div class="gc-sub">${esc(v.sub)}</div>
         <div class="gc-counts">${v.caps} capabilit${v.caps === 1 ? 'y' : 'ies'} · ${degConn} connection edge${degConn === 1 ? '' : 's'}</div>`) + actions;
    card.querySelector('.gc-open').addEventListener('click', (ev) => { ev.stopPropagation(); navTo(v); });
    card.hidden = false;
  }
  function hideCard() { const c = root.querySelector('#g-card'); if (c) c.hidden = true; selected = null; }

  // ---- frame loop ----
  function frame() {
    raf = requestAnimationFrame(frame);
    if (panel.hidden || !svg) return;
    step();
    const now = Date.now();
    vertices.forEach((v) => {
      const g = layer[v.id], p = pos.get(v.id);
      if (g && p) g.setAttribute('transform', `translate(${p.x},${p.y})`);
    });
    edges.forEach((e) => {
      const key = e.kind + ':' + (e.id || e.a + '→' + e.b);
      const el = layer[key];
      if (!el) return;
      el.setAttribute('d', edgePath(e));
      if (e.kind === 'conn') el.classList.toggle('g-hot', (hotUntil.get(e.id) || 0) > now);
    });
  }

  function rebuild() { buildGraph(); buildDom(); }
  onChange(rebuild);
  rebuild();
  raf = requestAnimationFrame(frame);
})();
