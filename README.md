# DDNet Demo Analyzer (website)

Static site: plain HTML + CSS + JavaScript. No build step, no dependencies, no backend.
The demo file is analysed in the visitor's browser and never uploaded.

## Run locally
Browsers refuse to start Web Workers from `file://`, so serve the folder over http:

    python serve.py 8000

then open http://localhost:8000

`serve.py` also sends the COOP/COEP headers the replay client needs. A plain
`python -m http.server` works too: `coi-serviceworker.js` adds those headers and
reloads the page once on the first visit.

## Files
| File | Job |
|---|---|
| index.html | page structure (+ Content-Security-Policy) |
| css/style.css | look, dark/light theme |
| js/app.js | file input, tables, charts (UI only) |
| js/worker.js | background thread: runs the parser so the page never freezes |
| js/demo-parser.js | header + chunk reader (snapshots and messages) |
| js/huffman.js | Huffman + varint decompression |
| js/snapshot.js | full snapshots and deltas |
| js/freeze-analyzer.js | collects every freeze run per player, plus first/last tick seen (for time alive) |
| js/save-analyzer.js | collects candidate saves (hammer frees + long hook holds + updown re-grabs) |
| js/team-analyzer.js | reads Sv_TeamsState messages: which players were in a team |
| js/map-reader.js | unpacks the map embedded in the demo: size + game tile grid (for the heatmap background) |
| js/heat-analyzer.js | counts, per player, how long they spent on each map tile and how much of it frozen; the UI sums those tiles into selectable N×N areas |
| client/replay.html | full-screen replay player (loads on demand, in an iframe or its own tab) |
| client/replay.js | boots the WebAssembly client, hands it the demo, drives playback |
| client/DDNet.js/.wasm/.data | the client build behind ddnet.org/watch (~51 MB, served locally) |
| coi-serviceworker.js | COOP/COEP on static hosts that cannot set headers |

## Adding a new statistic
1. Write a collector class like `FreezeCollector` (an `onSnapshot(tick, snap)` method plus `result()`).
2. Call it from `worker.js` next to the freeze collector.
3. Render its result in `app.js`.

## Publishing
Upload the folder to any static host (GitHub Pages, Netlify, Cloudflare Pages). Nothing else needed.

`client/DDNet.*` is ~51 MB and is requested only when a visitor presses "Watch
replay". The player downloads, boots and keeps that client once; analysing
another demo swaps the new demo into the running client instead of loading it
again (the second replay starts in well under a second). That button plays the
replay over the statistics; "New tab" puts it in its own tab through
`window.open` and passes the demo with `postMessage`, so the statistics stay
visible. Only one client runs at a time: switching between the overlay and the
tab, or reloading the page, boots a fresh one (the browser then serves the files
from its HTTP cache, which `serve.py` marks as `immutable`). The player runs the
real DDNet client: the client code is zlib-licensed and the game assets are
CC BY-SA 3.0; both are credited in the page footer and in the player's loading
screen.
