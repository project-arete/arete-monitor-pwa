// browser-arete.js — the PWA replacement for Electron's main process + preload.
// Implements the same `window.arete` bridge the Monitor renderer already uses,
// on top of a browser-native port of the Arete SDK client (native WebSocket,
// no Node). Read-mostly observer: connecting does NOT register anything on the
// realm; the explicit "Register node & context" button still works.
//
// Browser realities (vs the desktop app):
//   - Self-signed TLS cannot be bypassed — the realm needs a valid certificate.
//   - Browsers do not attach HTTP Basic credentials to WebSocket connects, so
//     username/password only work where the control plane accepts them in the
//     URL path/query or not at all. Open realms and valid-cert hosts work today.
//   - Settings live in localStorage (password only if explicitly remembered).

(() => {
  'use strict';

  const LS_SETTINGS = 'arete-monitor-settings';
  const LS_IDENTITY = 'arete-monitor-identity';
  const RETRY_MS = 5000;
  const KEYS_DEBOUNCE_MS = 400;

  // ------------------------------------------------------------ tiny emitter
  class Emitter {
    #h = {};
    on(ev, fn) { (this.#h[ev] || (this.#h[ev] = [])).push(fn); return this; }
    emit(ev, ...args) { for (const fn of [...(this.#h[ev] || [])]) fn(...args); return this; }
  }

  // -------------------------------------------------- SDK merge (ported 1:1)
  const getType = (v) => Object.prototype.toString.call(v);
  function merge(target, source) {
    for (const key in source) {
      const value = source[key];
      const type = getType(value);
      if (type === '[object Null]') delete target[key];
      else if (type === '[object Object]') {
        if (getType(target[key]) !== type || Object.keys(value).length === 0) target[key] = {};
        merge(target[key], value);
      } else target[key] = value;
    }
  }

  // ------------------------------------------- browser port of the SDK client
  class BrowserAreteClient extends Emitter {
    constructor(url) {
      super();
      this.url = url;
      this.userClosed = false;
      this.socket = undefined;
      this.#reset();
      this.open();
    }
    #reset() {
      if (this.requests) for (const t in this.requests) this.requests[t].reject(new Error('Socket request failed: ' + t));
      this.transaction = 1;
      this.requests = {};
      this.updates = 0;
      this.cache = { version: '', stats: {}, keys: {} };
    }
    open() {
      if (this.socket !== undefined || this.userClosed) return;
      this.#reset();
      this.socket = new WebSocket(this.url);
      this.socket.onmessage = (e) => this.#onmessage(e);
      this.socket.onclose = (e) => this.#onclose(e);
      this.socket.onerror = () => this.emit('error', new Error('Socket not open'));
    }
    async waitForOpen(timeout = 10000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        if (this.updates > 0) return; // first snapshot merged = truly ready
        if (this.userClosed) throw new Error('Connection cancelled');
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('Failed to connect within timeout');
    }
    isOpen() { return this.socket !== undefined && this.socket.readyState === WebSocket.OPEN; }
    get version() { return this.cache.version; }
    get stats() { return this.cache.stats; }
    get keys() { return this.cache.keys; }
    put(key, value) { return this.command('put', key, value); }
    command(cmd, ...args) { return this.#send('json', cmd, ...args); }
    close() {
      this.userClosed = true;
      if (this.socket !== undefined) this.socket.close();
      this.socket = undefined;
    }
    #onmessage(e) {
      try {
        const data = JSON.parse(e.data);
        if (data.transaction !== undefined) {
          const req = this.requests[data.transaction];
          if (req) { delete this.requests[data.transaction]; req.resolve(data); }
          return;
        }
        merge(this.cache, data);
        if (this.updates++ === 0) this.emit('open', e);
        this.emit('update', data);
      } catch (err) {
        this.emit('error', err);
      }
    }
    #onclose() {
      const hadSocket = this.socket !== undefined;
      this.socket = undefined;
      this.#reset();
      if (this.userClosed) return;
      if (hadSocket) this.emit('close');
      setTimeout(() => this.open(), RETRY_MS);
    }
    #send(format, cmd, ...args) {
      return new Promise((resolve, reject) => {
        if (!this.isOpen()) return reject(new Error('Socket not open'));
        for (const arg of args) cmd += ' "' + arg + '"';
        const transaction = this.transaction++;
        this.requests[transaction] = { resolve, reject };
        this.socket.send(JSON.stringify({ transaction, format, command: cmd }));
      });
    }
  }

  // ------------------------------------------------------------ persistence
  function readSettings() {
    try { return JSON.parse(localStorage.getItem(LS_SETTINGS)) || {}; } catch (_) { return {}; }
  }
  function writeSettings(patch) {
    const next = { ...readSettings(), ...patch };
    localStorage.setItem(LS_SETTINGS, JSON.stringify(next));
    return next;
  }
  function identity() {
    let id;
    try { id = JSON.parse(localStorage.getItem(LS_IDENTITY)); } catch (_) {}
    if (!id || !id.systemId) {
      const b62 = () => {
        const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        const bytes = crypto.getRandomValues(new Uint8Array(22));
        let s = ''; for (const b of bytes) s += A[b % 62]; return s;
      };
      id = {
        systemId: crypto.randomUUID(),
        node: { id: b62(), name: 'Monitor Node' },
        context: { id: b62(), name: 'Monitoring' },
      };
      localStorage.setItem(LS_IDENTITY, JSON.stringify(id));
    }
    return id;
  }

  // ------------------------------------------------------------ service state
  const bus = new Emitter();
  let client = null;
  let state = 'disconnected';
  let lastError = null;
  let currentHost = '';
  let registered = { system: null, node: null, context: null };
  let keysTimer = null;
  const profileCache = new Map();

  const log = (level, message) => bus.emit('log', { level, message, ts: Date.now() });
  function setState(s) { state = s; bus.emit('status', getStatus()); }
  function getStatus() {
    return {
      state,
      isOpen: !!(client && client.isOpen()),
      version: client ? client.version || '' : '',
      stats: client ? client.stats || {} : {},
      identity: registered,
      lastError,
      host: currentHost,
    };
  }
  function getKeys() {
    const src = client && client.keys ? client.keys : {};
    const out = {};
    for (const k in src) { if (!k.endsWith('/token')) out[k] = src[k]; }
    return out;
  }
  function scheduleKeysPush() {
    if (keysTimer) return;
    keysTimer = setTimeout(() => { keysTimer = null; bus.emit('keys', getKeys()); }, KEYS_DEBOUNCE_MS);
  }

  // ------------------------------------------------------------- the bridge
  window.arete = {
    async getDefaults() {
      const s = readSettings();
      const urlHost = new URLSearchParams(location.search).get('host');
      return {
        protocol: s.protocol || 'wss:',
        host: urlHost || s.host || '',
        port: s.port || 443,
        username: s.username || '',
        password: s.rememberPassword ? (s.password || '') : '',
        allowSelfSigned: false,
        rememberPassword: !!s.rememberPassword,
        autoConnect: !!s.autoConnect,
        identity: identity(),
        appVersion: 'PWA',
      };
    },

    async getSettings() {
      const s = readSettings();
      return { monitorName: s.monitorName || 'Arete Monitor', theme: s.theme || 'dark', hosts: s.hosts || [] };
    },
    async saveSettings(patch) { return writeSettings(patch || {}); },

    async connect(opts) {
      const { protocol = 'wss:', host, port = 443, username = '', password = '', allowSelfSigned, systemName } = opts || {};
      if (!host) throw new Error('A host is required to connect.');
      if (client) await this.disconnect();

      if (allowSelfSigned) {
        log('warn', 'Browsers cannot skip certificate validation — the realm must present a valid certificate. Trying anyway.');
      }
      if (username || password) {
        log('warn', 'Browsers do not attach Basic credentials to WebSocket connects — connecting without credentials.');
      }

      currentHost = host;
      lastError = null;
      setState('connecting');
      log('info', `Connecting to ${protocol}//${host}:${port} ...`);

      client = new BrowserAreteClient(`${protocol}//${host}${port ? ':' + port : ''}`);
      client.on('update', () => { bus.emit('status', getStatus()); scheduleKeysPush(); });
      client.on('open', () => {
        if (state === 'disconnected' || state === 'error') {
          log('info', 'Connection re-established — resuming.');
          setState('connected');
        }
      });
      client.on('close', () => {
        log('warn', 'Connection closed by host — retrying in the background.');
        setState('disconnected');
      });
      client.on('error', () => {
        lastError = 'Socket error (host unreachable, invalid certificate, or auth required)';
        log('error', lastError);
        setState('error');
      });

      try {
        await client.waitForOpen(12000);
      } catch (e) {
        lastError = String(e && e.message ? e.message : e);
        setState('error');
        try { client.close(); } catch (_) {}
        client = null;
        throw new Error(lastError);
      }

      setState('connected');
      log('info', 'Connected. Observing the realm (nothing registered).');

      // Remember this host (never the password unless asked).
      const s = readSettings();
      const hosts = (s.hosts || []).filter((h) => h.host !== host);
      hosts.unshift({ host, protocol, port, username, allowSelfSigned: false });
      writeSettings({
        host, protocol, port, username,
        hosts: hosts.slice(0, 8),
        monitorName: (systemName || '').trim() || s.monitorName || 'Arete Monitor',
        password: s.rememberPassword ? password : undefined,
      });
      return getStatus();
    },

    async disconnect() {
      if (client) { try { client.close(); } catch (_) {} client = null; }
      registered = { system: null, node: null, context: null };
      currentHost = '';
      if (keysTimer) { clearTimeout(keysTimer); keysTimer = null; }
      bus.emit('keys', {});
      setState('disconnected');
      log('info', 'Disconnected.');
      return getStatus();
    },

    async getStatus() { return getStatus(); },
    async getKeys() { return getKeys(); },

    async getProfile(name) {
      if (!name) return null;
      if (profileCache.has(name)) return profileCache.get(name);
      try {
        const res = await fetch('https://cp.padi.io/profiles/' + encodeURIComponent(name), { headers: { accept: 'application/json' } });
        const json = res.ok ? await res.json() : null;
        profileCache.set(name, json);
        return json;
      } catch (_) { profileCache.set(name, null); return null; }
    },

    // Explicit opt-in registration (System -> Node -> Context), same commands
    // as the desktop app. Requires a realm that accepts writes from this client.
    async register(override) {
      if (!client || !client.isOpen()) throw new Error('Not connected.');
      const id = identity();
      const name = (readSettings().monitorName || 'Arete Monitor');
      const node = (override && override.node) || id.node;
      const context = (override && override.context) || id.context;
      await client.command('systems', id.systemId, name);
      await client.command('nodes', id.systemId, node.id, node.name, false, null);
      await client.command('contexts', id.systemId, node.id, context.id, context.name);
      registered = { system: id.systemId, node, context };
      log('info', `Registered "${name}" on the realm (system ${id.systemId}).`);
      bus.emit('status', getStatus());
      return getStatus();
    },

    async openExternal(url) { window.open(url, '_blank', 'noopener'); },

    onKeys(cb) { bus.on('keys', cb); return () => {}; },
    onLog(cb) { bus.on('log', cb); return () => {}; },
    onStatus(cb) { bus.on('status', cb); return () => {}; },
  };

  // --------------------------------------------------------- service worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js')
        .then((reg) => { try { reg.update(); } catch (_) {} })
        .catch(() => {});
    });
    // When an updated worker activates, reload once so the new version shows
    // immediately (guarded so it can never loop).
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return;
      reloaded = true;
      if (navigator.serviceWorker.controller) location.reload();
    });
  }
})();
