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
| js/demo-cache.js | keeps the last analysis (and the demo file, up to 100 MB) in IndexedDB so the same tab can restore it |
| js/worker.js | background thread: runs the parser so the page never freezes |
| js/demo-parser.js | header + chunk reader (snapshots and messages) |
| js/huffman.js | Huffman + varint decompression |
| js/snapshot.js | full snapshots and deltas |
| js/freeze-analyzer.js | collects every freeze run per player, plus first/last tick seen (for time alive) |
| js/save-analyzer.js | collects candidate saves (hammer frees + long hook holds + updown re-grabs) |
| js/team-analyzer.js | reads Sv_TeamsState messages: which players were in a team |
| js/map-reader.js | unpacks the map embedded in the demo: size + game tile grid (for the heatmap background) |
| js/heat-analyzer.js | counts, per player, how long they spent on each map tile and how much of it frozen; the UI sums those tiles into selectable N×N areas |
| js/jump-analyzer.js | counts air jumps (double jumps) per player from the server's jump counter |
| js/emote-analyzer.js | counts the exact emote bubbles per player and type from `Sv_Emoticon` messages |
| fun.html | extra page for experimental/funny stats (double jumps and emotes) |
| js/fun.js | UI for the fun page: demo upload, the double-jump table and the emote matrix |
| client/replay.html | full-screen replay player (loads on demand, in an iframe or its own tab) |
| client/replay.js | boots the WebAssembly client, hands it the demo, drives playback |
| client/DDNet.js/.wasm/.data | the client build behind ddnet.org/watch (~51 MB, served locally) |
| coi-serviceworker.js | COOP/COEP on static hosts that cannot set headers |

## Adding a new statistic
1. Write a collector class like `FreezeCollector` (an `onSnapshot(tick, snap)` method plus `result()`).
2. Call it from `worker.js` next to the freeze collector.
3. Render its result in `app.js`.

## Fun stats
`fun.html` is a separate page for experimental counters that would only distract from
the serious analysis. It asks the worker for `funOnly` mode, which skips the map/heat
work and returns just the fun collectors. Double jumps use
`js/jump-analyzer.js`; emotes use `js/emote-analyzer.js`; add another collector there
and another table in `js/fun.js` when a new silly idea comes along.

The analyzer's "Fun stats" link hands over the demo it just analysed: the main
worker runs the same jump and emote collectors and `js/app.js` keeps their small
result (a few KB, never the demo bytes) in `sessionStorage` under `dda:lastFun`.
The fun page picks that up on load, so the file does not have to be dropped twice,
and the data disappears when the tab closes. The collectors only decode a player's
name when its `ClientInfo` actually changes, which keeps the extra work in the
single-digit percent range. Dropping a file on the fun page still analyses it
standalone; dropping another file there or on the analyzer replaces the stored one.

### Restoring the last demo
`js/demo-cache.js` stores the last analysis in IndexedDB, together with the demo
file when it is at most 100 MB, so reloading the page or going to the fun page and
back shows the tables and heatmap again without dropping the file. A random id in
`sessionStorage` ties the record to the tab: a new tab starts empty, and the
restored note names the demo. If the file was too large to keep, the statistics are
still restored and the replay buttons ask for the file again; dropping any demo
replaces the record.

### Emote icons
The emote table is built in `js/fun.js`. Its icon setup is the clearly marked
`EMOTE ICONS - EDIT THIS BLOCK` near the top: put an image URL in `EMOTE_ICON_URLS`
for each emote (for example `HEARTS: 'Assets/Icons/emote_03.png'`). Leave an entry
empty to show the emote name as text. The keys are the protocol names from
`EMOTES` in `js/emote-analyzer.js` and must not be renamed; use the optional
`EMOTE_LABELS` map in the same block to give a column a friendlier tooltip name.
Paths must use forward slashes, since a single backslash is a JavaScript escape
character. If you prefer CSS sprites or inline SVG, edit `emoteIcon()` in the same
block and target the `.emote-hearts` classes in `css/style.css`. Icons must be
local or data URLs because the page's CSP allows only `'self'` and `data:` images;
the icon box size is set by `#emotes-table .emote-icon` in `css/style.css`.

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
