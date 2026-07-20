# Arete Monitor — PWA

**[Open the app → project-arete.github.io/arete-monitor-pwa](https://project-arete.github.io/arete-monitor-pwa/)**

[Arete Monitor](https://github.com/project-arete/arete-monitor) as an
installable web app: live monitoring of a CNS/CP realm — systems, contexts,
connections, and a realm graph — in any modern browser, with nothing to
install. Add it to your phone's home screen and it behaves like a native app.

## Install on a phone

- **iPhone / iPad** — open the app URL in Safari → Share → **Add to Home Screen**.
- **Android** — open it in Chrome → accept the **Install app** prompt (or ⋮ → Install app).
- **Desktop** — Chrome/Edge show an install icon at the right end of the address bar.

## Connecting

Enter your realm host on the **Config** tab (e.g. `my.aretehosting.com`) and
Connect. Notes for the browser world:

- The realm must present a **valid TLS certificate** — browsers cannot skip
  certificate checks the way the desktop app can. All `*.aretehosting.com`
  realms qualify.
- Browsers do not attach Basic credentials to WebSocket connects, so realms
  requiring auth are not reachable from the PWA yet.
- Connecting is **observe-only** — nothing is registered on the realm unless
  you explicitly press *Register node & context*.

## Relationship to the desktop app

The six monitor views are byte-identical copies of the
[arete-monitor](https://github.com/project-arete/arete-monitor) renderer.
Everything Electron did is replaced by three files: `browser-arete.js`
(a browser-native port of the Arete SDK wire protocol + the `window.arete`
bridge), `mobile.css` (responsive overlay), and the PWA shell
(`sw.js`, `manifest.webmanifest`, icons). When the desktop renderer evolves,
copy the view files over and bump the service-worker version.

`Start Monitor PWA.command` serves the app locally on macOS for development.
