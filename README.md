# DDNet Demo Analyzer

Drop a DDNet `.demo` file and find out how a run went: who failed the most, where
the team kept getting stuck, how long everyone survived - plus a few fun extras.
Everything runs locally in your browser; the demo file is never uploaded.

## Quick start

Browsers refuse to load demos straight from disk, so serve the folder over HTTP:

    python serve.py 8000

Then open http://localhost:8000 and drop a `.demo` file onto the page. The
statistics appear after a few seconds.

## What you can do

- **See the fails.** A "fail" is a freeze longer than the number you choose in
  the box, so you can decide what counts. The table lists fails and freeze times
  per player (split by team); click a player to see their individual fails.
- **Find the chokepoints.** The heatmap shows where on the map players spent
  their time and where the team struggled, with the worst chokepoints marked.
- **Check survival and saves.** A "time alive" chart per player and a
  "who saved whom" section.
- **Watch the replay.** Plays the demo in the real DDNet client right on the
  page. The client (~51 MB) is downloaded once and reused afterwards.
- **Fun stats.** The link in the top corner opens a second page with double
  jumps and emotes per player. It reuses the analysis you just ran, so no need
  to drop the file twice.

Reloading the page - or visiting the fun page and coming back - restores your
last analysis automatically.

## Notes

- Plain static site: HTML, CSS and JavaScript, no build step, no dependencies.
  Upload the folder to any static host (GitHub Pages, Netlify, Cloudflare Pages)
  to publish it.
- Internally the parsing runs in a web worker (`js/worker.js`), with one
  collector per statistic (`js/*-analyzer.js`).
- The replay player uses the DDNet client (zlib licence) with the game assets
  (CC BY-SA 3.0); both are credited in the page footer.
- Emote icons on the fun page can be customised in the clearly marked
  `EMOTE ICONS - EDIT THIS BLOCK` at the top of `js/fun.js`.
