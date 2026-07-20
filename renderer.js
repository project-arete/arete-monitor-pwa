// renderer.js — runs in the sandboxed page. Talks to main ONLY through
// window.arete (see preload.cjs). No Node, no SDK here.

const $ = (id) => document.getElementById(id);

const els = {
  form: $('connectForm'),
  protocol: $('protocol'),
  host: $('host'),
  port: $('port'),
  username: $('username'),
  password: $('password'),
  allowSelfSigned: $('allowSelfSigned'),
  connectBtn: $('connectBtn'),
  disconnectBtn: $('disconnectBtn'),
  registerBtn: $('registerBtn'),
  clearLogBtn: $('clearLogBtn'),
  monitorName: $('monitorName'),
  themeLight: $('themeLight'),
  hostList: $('hostList'),
  realmInd: $('realmInd'),
  realmHost: $('realmHost'),
  rememberPassword: $('rememberPassword'),
  autoConnect: $('autoConnect'),
  statusDot: $('statusDot'),
  statePill: $('statePill'),
  statusBadge: $('statusBadge'),
  panelStatus: $('panel-status'),
  log: $('log'),
  coreVersion: $('coreVersion'),
  realmSizeNote: $('realmSizeNote'),
  realmSubStats: $('realmSubStats'),
  rc: { systems: $('rc-systems'), nodes: $('rc-nodes'), contexts: $('rc-contexts'), connections: $('rc-connections') },
  s: {
    state: $('s-state'),
    open: $('s-open'),
    version: $('s-version'),
    system: $('s-system'),
    node: $('s-node'),
    context: $('s-context'),
    error: $('s-error'),
  },
};

let identity = null;
let knownHosts = [];

// ---- Realm size (Status page) ----
// Counts come straight from AreteModel's structural parse of the live keys —
// the same numbers the Home/Contexts/Connections views are built from — so the
// summary can never disagree with the detail views. "Connected" is derived
// from keys presence exactly like those views (NOT a separate status flag),
// and it re-renders on every keys push.
function renderRealmCounts() {
  const AM = window.AreteModel;
  if (!AM) return;
  const keys = AM.getKeys();
  if (!Object.keys(keys).length) {
    for (const k in els.rc) els.rc[k].textContent = '—';
    els.realmSizeNote.textContent = 'not connected';
    els.realmSubStats.textContent = '';
    return;
  }
  const c = AM.parseKeys(keys).counts;
  els.rc.systems.textContent = c.systems;
  els.rc.nodes.textContent = c.nodes;
  els.rc.contexts.textContent = c.contexts;
  els.rc.connections.textContent = c.connections;
  els.realmSizeNote.textContent = 'live';
  const unbound = c.unbound
    ? ` · <b>${c.unbound}</b> awaiting broker`
    : '';
  els.realmSubStats.innerHTML =
    `<b>${c.capabilities}</b> capabilit${c.capabilities === 1 ? 'y' : 'ies'} declared ` +
    `· <b>${c.providers}</b> provider${c.providers === 1 ? '' : 's'} ` +
    `· <b>${c.consumers}</b> consumer${c.consumers === 1 ? '' : 's'}${unbound}`;
}

// Register the live subscription + paint once, the same way the other views do
// (onChange + immediate render). renderer.js loads BEFORE arete-model.js, so we
// wait for DOMContentLoaded — by then every view script has run and
// window.AreteModel exists and is already primed. Registering synchronously
// here (rather than after an await in init) is what makes us catch the very
// first keys push on a static realm.
function wireRealmCounts() {
  if (!window.AreteModel) return;
  window.AreteModel.onChange(renderRealmCounts);
  renderRealmCounts();
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireRealmCounts);
} else {
  wireRealmCounts();
}

// Past-hosts dropdown: fill the datalist, and when a remembered host is picked
// (or typed exactly), recall its connection shape — never the password.
function refreshHosts(hosts) {
  knownHosts = hosts || [];
  els.hostList.innerHTML = knownHosts
    .map((h) => `<option value="${h.host.replace(/"/g, '&quot;')}"></option>`)
    .join('');
}
function applyKnownHost(value) {
  const h = knownHosts.find((x) => x.host === value);
  if (!h) return;
  if (h.protocol) els.protocol.value = h.protocol;
  if (h.port) els.port.value = h.port;
  els.username.value = h.username || '';
  els.allowSelfSigned.checked = !!h.allowSelfSigned;
}

// ---- Tabs ----
function activateTab(panelId) {
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.panel === panelId;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.panel').forEach((p) => {
    p.hidden = p.id !== panelId;
  });
  if (panelId === 'panel-status') els.statusBadge.hidden = true; // clear unread marker
}
document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => activateTab(t.dataset.panel))
);

// Any view can render a <button class="go-config">Config</button> in its
// not-connected message; this one delegated handler makes them all navigate.
document.addEventListener('click', (e) => {
  if (e.target.closest && e.target.closest('.go-config')) activateTab('panel-home');
});

function logLine(entry) {
  const time = new Date(entry.ts || Date.now()).toLocaleTimeString();
  const line = document.createElement('span');
  line.className = 'l';
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = `[${time}] `;
  const msg = document.createElement('span');
  msg.className = entry.level || 'info';
  msg.textContent = entry.message;
  line.appendChild(t);
  line.appendChild(msg);
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
  // Surface new activity on the Status tab when the user isn't looking at it.
  if (els.panelStatus.hidden) els.statusBadge.hidden = false;
}

function renderStatus(st) {
  if (!st) return;
  const state = st.state || 'disconnected';
  els.statusDot.dataset.state = state;
  els.statePill.textContent = state;
  els.statePill.className = 'state-pill ' +
    (state === 'connected' ? 'ok' : state === 'connecting' ? 'mid' : 'bad');
  // centered realm indicator
  const showRealm = !!st.host && (state === 'connected' || state === 'connecting');
  els.realmInd.hidden = !showRealm;
  if (showRealm) els.realmHost.textContent = st.host;
  els.s.state.textContent = state;
  els.s.open.textContent = st.isOpen ? 'yes' : 'no';
  els.s.version.textContent = st.version || '—';
  els.s.system.textContent = (st.identity && st.identity.system) || '—';
  const node = st.identity && st.identity.node;
  const ctx = st.identity && st.identity.context;
  els.s.node.textContent = node ? `${node.name} (${node.id})` : '—';
  els.s.context.textContent = ctx ? `${ctx.name} (${ctx.id})` : '—';
  els.s.error.textContent = st.lastError || '—';

  const connected = state === 'connected';
  els.connectBtn.disabled = connected || state === 'connecting';
  els.disconnectBtn.disabled = state === 'disconnected';
  els.registerBtn.disabled = !connected;
  renderRealmCounts(); // keep the realm-size card fresh as state changes
}

async function init() {
  const d = await window.arete.getDefaults();
  identity = d.identity;
  if (d.appVersion && els.coreVersion) els.coreVersion.textContent = `core v${d.appVersion}`;
  els.protocol.value = d.protocol;
  els.host.value = d.host;
  els.port.value = d.port;
  els.username.value = d.username;
  els.password.value = d.password;
  els.allowSelfSigned.checked = !!d.allowSelfSigned;

  // user preferences: monitor name + theme + past hosts
  const s = await window.arete.getSettings();
  els.monitorName.value = s.monitorName || 'Arete Monitor';
  const light = s.theme === 'light';
  document.body.classList.toggle('light', light);
  els.themeLight.checked = light;
  refreshHosts(s.hosts);

  els.rememberPassword.checked = !!d.rememberPassword;
  els.autoConnect.checked = !!d.autoConnect;

  window.arete.onLog(logLine);
  window.arete.onStatus(renderStatus);
  renderStatus(await window.arete.getStatus());
  logLine({ level: 'info', message: 'Ready. Enter credentials and Connect.', ts: Date.now() });

  // Auto-connect on launch: opt-in, and only when a host is known.
  if (d.autoConnect && els.host.value.trim()) {
    logLine({ level: 'info', message: `Auto-connecting to ${els.host.value.trim()} ...`, ts: Date.now() });
    doConnect(true);
  }
}

async function doConnect(isAuto) {
  els.connectBtn.disabled = true;
  const opts = {
    protocol: els.protocol.value,
    host: els.host.value.trim(),
    port: Number(els.port.value),
    username: els.username.value.trim(),
    password: els.password.value,
    allowSelfSigned: els.allowSelfSigned.checked,
    systemName: els.monitorName.value.trim() || 'Arete Monitor',
  };
  try {
    await window.arete.connect(opts);
    // main recorded this host on success — refresh the dropdown
    const s = await window.arete.getSettings();
    refreshHosts(s.hosts);
  } catch (err) {
    logLine({ level: 'error', message: String(err.message || err), ts: Date.now() });
    els.connectBtn.disabled = false;
    // a failed auto-connect lands you on Config with the error in the log
    if (isAuto) activateTab('panel-home');
  }
}

els.form.addEventListener('submit', (e) => { e.preventDefault(); doConnect(false); });

// picking (or exactly typing) a remembered host recalls its port/user/TLS
els.host.addEventListener('input', () => applyKnownHost(els.host.value.trim()));
els.host.addEventListener('change', () => applyKnownHost(els.host.value.trim()));

els.disconnectBtn.addEventListener('click', () => window.arete.disconnect());

els.registerBtn.addEventListener('click', async () => {
  els.registerBtn.disabled = true;
  try {
    await window.arete.register(identity);
  } catch (err) {
    logLine({ level: 'error', message: String(err.message || err), ts: Date.now() });
  } finally {
    els.registerBtn.disabled = false;
  }
});

els.clearLogBtn.addEventListener('click', () => (els.log.innerHTML = ''));

els.rememberPassword.addEventListener('change', () =>
  window.arete.saveSettings({ rememberPassword: els.rememberPassword.checked }));
els.autoConnect.addEventListener('change', () =>
  window.arete.saveSettings({ autoConnect: els.autoConnect.checked }));

els.themeLight.addEventListener('change', () => {
  const light = els.themeLight.checked;
  document.body.classList.toggle('light', light);
  window.arete.saveSettings({ theme: light ? 'light' : 'dark' });
});

init().catch((e) => logLine({ level: 'error', message: 'Init failed: ' + e, ts: Date.now() }));
