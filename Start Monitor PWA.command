#!/bin/bash
# Serves the Arete Monitor PWA locally and opens it in your browser.
# On an iPhone/iPad on the same Wi-Fi, browse to the http://<mac-ip>:8123
# address printed below. (Installing to the Home Screen needs HTTPS hosting —
# this local server is for trying the app.)
cd "$(dirname "$0")"
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "<your-mac-ip>")
echo "Arete Monitor PWA:  http://localhost:8123"
echo "From your phone:    http://$IP:8123"
(sleep 1 && open "http://localhost:8123") &
python3 -m http.server 8123
