---
name: jump-graph-visual-check
description: Check a change to the Jump Graph webview (src/webview/) by rendering the real bundle in Playwright + Chromium and looking at a screenshot. Use when changing what the graph draws, its layout or its interaction.
---

# Visual check of the Jump Graph

Playwright + Chromium (dev-only, see **Critical Invariants → Browser tooling**) is the approved way to check
changes to the Jump Graph webview (`src/webview/`): render the real bundle, screenshot it, and look at the
image instead of guessing from the code. Unit tests cover the view model and layout (`src/common/jumpGraph*.ts`)
but not what Cytoscape draws.

How:
- Bundle the webview straight into the scratch directory
  (`npx esbuild src/webview/graph.ts --bundle --outfile=<scratch>/graph.js --platform=browser --format=iife`);
  copying from `out/` is blocked by the deny rules.
- Build the page from the HTML template in `src/client/jumpGraph.ts`: drop the CSP meta, stub
  `acquireVsCodeApi()` (record `postMessage` calls, `getState()` → `undefined`), and set a few `--vscode-*` colours on `<body>`.
- Drive it with `window.postMessage({ type: 'graph', ... })` / `{ type: 'focus', ... }` (`HostToWebview`).
  Wait until `#status` no longer starts with `Laying out`. Layout timings arrive as `{ type: 'log' }` messages.
- For large-project behaviour use a synthetic graph of the size of a real game (~1000 locations, ~4000 jumps, a few hubs).
- The Cytoscape instance is `document.getElementById('graph')._cyreg.cy`, so a test can emit `tap`/`mouseover` on elements.
- Don't return Cytoscape objects from `page.evaluate` (see **Critical Invariants → Browser tooling**).
