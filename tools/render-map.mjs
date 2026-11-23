#!/usr/bin/env node
// Render map/station-map.mmd to map/station-map.svg. tools/build.mjs then puts it
// in every page and marks "you are here".
//
// The site ships no JavaScript, so Mermaid runs here, offline, in a headless browser
// with the site's own stylesheet and fonts loaded, so text is measured exactly as the
// site will draw it. Then:
//   - all of Mermaid's styling is stripped (the site's CSP would block it anyway);
//   - boxes and section titles are re-fitted to the real text;
//   - each box becomes a focusable "spot" with a callout: hover (mouse) or first tap
//     shows the place's full name, and the callout links to the place's page.
// Names and pages come from pages/places.json, matched by Mermaid node id.
//
// Setup (once):  npm --prefix tools install
//                npm --prefix tools install playwright && npx --prefix tools playwright install chromium
// Run:           node tools/render-map.mjs && node tools/build.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'tools', 'package.json'));
const { chromium } = require('playwright');
const mermaidJs = require.resolve('mermaid/dist/mermaid.min.js');

const SRC = join(root, 'map', 'station-map.mmd');
const OUT = join(root, 'map', 'station-map.svg');
const ORIGIN = 'http://timda.render';

const source = await readFile(SRC, 'utf8');
const places = JSON.parse(await readFile(join(root, 'pages', 'places.json'), 'utf8'));

const browser = await chromium.launch();
const page = await browser.newPage();

// Serve the repo to the render page from a fake origin, so fonts and CSS load.
await page.route(`${ORIGIN}/**`, async (route) => {
  const path = decodeURIComponent(new URL(route.request().url()).pathname);
  if (path === '/render.html') {
    return route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><meta charset="utf-8">
        <link rel="stylesheet" href="/public/style.css">
        <body><section class="directory"><div class="station-map" id="out"></div></section>
        <script src="/mermaid.js"></script>`,
    });
  }
  // style.css uses absolute /fonts/… URLs; serve them from public/.
  const file = path === '/mermaid.js' ? mermaidJs : path.startsWith('/fonts/') ? join(root, 'public', path) : join(root, path);
  try {
    const body = await readFile(file);
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : 'application/javascript';
    return route.fulfill({ body, contentType: type });
  } catch {
    return route.fulfill({ status: 404, body: 'not found' });
  }
});

await page.goto(`${ORIGIN}/render.html`);
await page.evaluate(() => document.fonts.ready);

const svg = await page.evaluate(async ({ src, places }) => {
  await Promise.all([
    document.fonts.load('400 15px "Space Mono"'),
    document.fonts.load('700 13px "Space Grotesk"'),
  ]);
  window.mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    htmlLabels: false, // plain SVG <text>, so the site's CSS styles it and nothing is clipped
    flowchart: { htmlLabels: false, curve: 'linear', nodeSpacing: 24, rankSpacing: 28, padding: 12, useMaxWidth: false, wrappingWidth: 400 },
  });
  const out = document.getElementById('out');
  const { svg } = await window.mermaid.render('station-map', src);
  out.innerHTML = svg;
  const el = out.querySelector('svg');
  const SVG = 'http://www.w3.org/2000/svg';
  const byId = Object.fromEntries(places.map((p) => [p.id, p]));

  // 1. Strip Mermaid's styling; from here on only the site's stylesheet applies.
  el.querySelectorAll('style').forEach((s) => s.remove());
  [el, ...el.querySelectorAll('*')].forEach((n) => n.removeAttribute('style'));
  el.removeAttribute('width');
  el.removeAttribute('height');
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'Station map');

  // 2. Mermaid measured text in its own font. Re-fit section titles (centred on their
  //    box) and boxes (even padding around the real text).
  const translateOf = (n) => {
    const m = ((n.getAttribute && n.getAttribute('transform')) || '').match(/translate\(\s*([-\d.]+)[\s,]+([-\d.]+)\s*\)/);
    return m ? [Number(m[1]), Number(m[2])] : [0, 0];
  };
  el.querySelectorAll('g.cluster').forEach((c) => {
    const rect = c.querySelector(':scope > rect');
    const label = c.querySelector(':scope > .cluster-label');
    if (!rect || !label) return;
    const cx = Number(rect.getAttribute('x')) + Number(rect.getAttribute('width')) / 2;
    label.setAttribute('transform', `translate(${cx}, ${translateOf(label)[1]})`);
    label.querySelectorAll('text').forEach((t) => t.setAttribute('text-anchor', 'middle'));
  });
  const PAD_X = 16;
  el.querySelectorAll('g.node').forEach((n) => {
    const rect = n.querySelector(':scope > rect');
    const text = n.querySelector('text');
    if (!rect || !text) return;
    const w = Math.ceil(text.getBBox().width) + 2 * PAD_X;
    rect.setAttribute('width', String(w));
    rect.setAttribute('x', String(-w / 2));
  });

  // 3. Spots: every box becomes focusable, with a callout that links to its page.
  //    Hover (mouse) or focus (click, tap, Tab) shows the callout; pure CSS.
  const absolute = (n) => { let x = 0, y = 0; for (let p = n; p && p !== el; p = p.parentNode) { const [dx, dy] = translateOf(p); x += dx; y += dy; } return [x, y]; };
  const vb = el.viewBox.baseVal;
  const layer = document.createElementNS(SVG, 'g');
  layer.setAttribute('class', 'spots');
  el.appendChild(layer); // last, so callouts paint over every box, line and outline

  const spots = [...el.querySelectorAll('g.node')].map((node) => {
    const id = (node.id.match(/flowchart-(.+)-\d+$/) || [])[1];
    const place = byId[id];
    if (!place) throw new Error(`map node "${id}" has no entry in pages/places.json`);
    return { node, place, at: absolute(node) };
  });
  spots.sort((p, q) => p.at[1] - q.at[1] || p.at[0] - q.at[0]); // reading order for Tab

  let bottom = vb.y + vb.height;
  for (const { node, place, at } of spots) {
    const spot = document.createElementNS(SVG, 'g');
    spot.setAttribute('class', 'spot');
    spot.setAttribute('tabindex', '0');
    spot.setAttribute('data-place', place.id);
    spot.setAttribute('transform', `translate(${at[0]}, ${at[1]})`);
    const title = document.createElementNS(SVG, 'title');
    title.textContent = place.name;
    spot.appendChild(title);
    node.removeAttribute('transform'); // the spot carries the position now
    node.removeAttribute('id');
    spot.appendChild(node);
    layer.appendChild(spot);

    const box = node.querySelector(':scope > rect');
    const h = Number(box.getAttribute('height'));
    const halfW = Number(box.getAttribute('width')) / 2;
    const link = document.createElementNS(SVG, 'a');
    link.setAttribute('class', 'callout');
    link.setAttribute('href', `/${place.slug}`);
    const bridge = document.createElementNS(SVG, 'rect');
    bridge.setAttribute('class', 'bridge');
    const bg = document.createElementNS(SVG, 'rect');
    const text = document.createElementNS(SVG, 'text');
    link.append(bridge, bg, text);
    spot.appendChild(link);
    link.setAttribute('style', 'display:inline'); // measurable while we size it; removed below

    // One line if it fits inside the map, otherwise two, split at the space nearest the middle.
    const label = `${place.name} →`;
    const setLines = (lines) => {
      text.textContent = '';
      lines.forEach((line, i) => {
        const t = document.createElementNS(SVG, 'tspan');
        t.textContent = line;
        t.setAttribute('x', '0');
        t.setAttribute('dy', i === 0 ? '0' : '1.3em');
        text.appendChild(t);
      });
    };
    setLines([label]);
    if (text.getBBox().width > vb.width - 24) {
      const spaces = [...label.matchAll(/ /g)].map((m) => m.index);
      const mid = spaces.reduce((b, i) => (Math.abs(i - label.length / 2) < Math.abs(b - label.length / 2) ? i : b), spaces[0]);
      setLines([label.slice(0, mid), label.slice(mid + 1)]);
    }
    const tb = text.getBBox();
    const w = Math.ceil(tb.width) + 20, ch = Math.ceil(tb.height) + 12;
    const left = Math.max(vb.x + 2, Math.min(at[0] - w / 2, vb.x + vb.width - w - 2));
    const dx = left - at[0], dy = h / 2 + 6;
    bg.setAttribute('x', String(dx)); bg.setAttribute('y', String(dy));
    bg.setAttribute('width', String(w)); bg.setAttribute('height', String(ch));
    // Invisible strip over the gap, so a hovering mouse can move onto the callout.
    const bx = Math.max(dx, -halfW);
    bridge.setAttribute('x', String(bx)); bridge.setAttribute('y', String(h / 2 - 1));
    bridge.setAttribute('width', String(Math.min(dx + w, halfW) - bx));
    bridge.setAttribute('height', String(dy - h / 2 + 2));
    text.querySelectorAll('tspan').forEach((t) => t.setAttribute('x', String(dx + w / 2)));
    text.setAttribute('y', '0');
    text.setAttribute('y', String(dy + 6 - text.getBBox().y)); // text top 6 units inside the box
    link.removeAttribute('style');
    bottom = Math.max(bottom, at[1] + dy + ch + 4);
  }
  // Grow the canvas so the lowest callout stays inside the map.
  el.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.width} ${bottom - vb.y}`);
  return el.outerHTML;
}, { src: source, places });

await browser.close();
await writeFile(OUT, svg + '\n');
console.log(`station map: ${svg.length} bytes -> map/station-map.svg`);
