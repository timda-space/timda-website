#!/usr/bin/env node
// Build the site's pages from pages/ into public/. No dependencies.
//
//   pages/places.json   every place on the station: id, page slug, deck, full name
//   pages/_layout.html  the shared page shell
//   pages/<slug>.html   one page's content, with a small header comment:
//                         <!--
//                         place: mall            (omit for pages that aren't a place)
//                         title: EconoMatic HyperMall
//                         description: …
//                         -->
//   map/station-map.svg the rendered station map (tools/render-map.mjs)
//
// Every page gets the station directory (map + list) as a drop-down, with the
// current place marked "you are here". Run: node tools/build.mjs

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markdown } from './markdown.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const P = (...p) => join(root, ...p);

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const indent = (s, n) => s.split('\n').map((l) => (l ? ' '.repeat(n) + l : l)).join('\n');

const places = JSON.parse(await readFile(P('pages', 'places.json'), 'utf8'));
// Fingerprint the stylesheet so its URL changes whenever it does. Browsers (iOS ones
// especially) can otherwise pair fresh HTML with a stale cached style.css.
const cssVersion = createHash('sha256').update(await readFile(P('public', 'style.css'))).digest('hex').slice(0, 10);
const layout = (await readFile(P('pages', '_layout.html'), 'utf8')).replace('href="/style.css"', `href="/style.css?v=${cssVersion}"`);
if (!layout.includes(`style.css?v=${cssVersion}`)) throw new Error('_layout.html must link /style.css');
const map = (await readFile(P('map', 'station-map.svg'), 'utf8')).trim();

// Fingerprint images the same way: every src, srcset or href to one of these gets
// ?v=<hash of the file>, so a redrawn button or icon is never served stale.
const ASSET_RE = /(?<=["\s,])(\/(?:ring\/[\w.-]+|art\/[\w.-]+|apple-touch-icon\.png|favicon\.svg))(?:\?v=[0-9a-f]*)?(?=["\s,])/g;
const assetVersions = new Map();
async function stampAssets(html) {
  for (const [, path] of html.matchAll(ASSET_RE)) {
    if (!assetVersions.has(path)) {
      assetVersions.set(path, createHash('sha256').update(await readFile(P('public', path))).digest('hex').slice(0, 10));
    }
  }
  return html.replace(ASSET_RE, (_, path) => `${path}?v=${assetVersions.get(path)}`);
}
const href = (place) => `/${place.slug}`;

function parsePage(text, file) {
  const m = /^<!--\n([\s\S]*?)\n-->\n/.exec(text);
  if (!m) throw new Error(`${file}: missing the header comment`);
  const meta = Object.fromEntries(m[1].split('\n').map((l) => {
    const i = l.indexOf(':');
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }));
  if (!meta.title) throw new Error(`${file}: header needs a title`);
  return { meta, body: text.slice(m[0].length).replace(/\s+$/, '') };
}

function directory(here) {
  // Mark "you are here" on the map: the place's box, or for a place drawn as a whole
  // section of the station (the Ivory Tower is the spine), that section's outline.
  const place = places.find((p) => p.id === here);
  let svg = map;
  if (place?.cluster) {
    svg = map.replace(`<g class="cluster" id="station-map-${place.cluster}"`, `<g class="cluster here" id="station-map-${place.cluster}"`);
  } else if (place) {
    svg = map.replace(`class="spot" tabindex="0" data-place="${here}"`, `class="spot here" tabindex="0" data-place="${here}"`);
  }
  if (place && svg === map) throw new Error(`place "${here}" is not on the station map`);
  // The map is the directory: tap a spot for its full name and a link. Mark the
  // current place's link for screen readers too.
  if (place && !place.cluster) {
    svg = svg.replace(`<a class="callout" href="${href(place)}">`, `<a class="callout" href="${href(place)}" aria-current="page">`);
  }
  return indent([
    '<section class="directory" aria-labelledby="directory">',
    '  <details>',
    '  <summary><h2 id="directory">Station directory</h2></summary>',
    '  <div class="station-map">',
    indent(svg, 4),
    '  </div>',
    '  </details>',
    '</section>',
  ].join('\n'), 4);
}

const ART_HEADER = `  <header class="viewport">
    <!-- Station art made with the Space Station Generator (CC BY-NC-ND 4.0).
         NoDerivatives: show it unmodified. Scale only; never crop, extend or draw on it. -->
    <img src="/art/station.png" width="320" height="180"
         alt="Pixel-art space station: a white dome on a central spine, two rings around the spine, and an antenna array underneath, floating among blue planets and stars.">
  </header>`;

const TOP_BAR = `  <header class="topbar">
    <a href="/" class="home">TIMDA</a>
    <span class="tagline">Technocratic Incorporated Multi-node Digital Astrodrome</span>
  </header>`;

const files = (await readdir(P('pages'))).filter((f) => f.endsWith('.html') && !f.startsWith('_')).sort();
const built = [];
for (const file of files) {
  const { meta, body } = parsePage(await readFile(P('pages', file), 'utf8'), file);
  const place = meta.place ? places.find((p) => p.id === meta.place) : null;
  if (meta.place && !place) throw new Error(`${file}: place "${meta.place}" isn't in places.json`);
  const isHome = place?.slug === '';
  const slug = file.replace(/\.html$/, '');
  if (place && !isHome && place.slug !== slug) throw new Error(`${file}: file name must match the slug "${place.slug}"`);

  const heading = isHome
    ? `    <h1>TIMDA</h1>\n    <p class="expansion"><span>Technocratic Incorporated</span> <span>Multi-node Digital Astrodrome</span></p>`
    : place
      ? `    <p class="deck-label">${esc(place.deck)}</p>\n    <h1 class="place">${esc(place.name)}</h1>`
      : `    <h1 class="place">${esc(meta.title)}</h1>`;

  const html = layout
    .replace('{{title}}', esc(isHome ? 'TIMDA' : `${meta.title} · TIMDA`))
    .replace('{{description}}', esc(meta.description ?? ''))
    .replace('{{header}}', isHome ? ART_HEADER : TOP_BAR)
    // The directory is navigation: on inner pages it comes first, under the TIMDA bar
    // and above the page's own title. On Arrivals the big TIMDA title is the banner,
    // so there it stays banner, then directory.
    .replace('{{heading}}', isHome ? heading : directory(place?.id))
    .replace('{{directory}}', isHome ? directory(place?.id) : heading)
    .replace('{{body}}', body);
  const out = isHome ? 'index.html' : `${slug}.html`;
  await writeFile(P('public', out), await stampAssets(html));
  built.push(out);
}

// The specs, from specs/ (copies of the timda.space repo's), at /rnd/timda-<n>: in
// R&D on the map. Links between specs go to their pages; the docking guide, to /dock.
const specFiles = (await readdir(P('specs'))).filter((f) => /^\d{4}-.*\.md$/.test(f)).sort();
const specPage = (f) => `/rnd/timda-${Number(f.slice(0, 4))}`;
const specLink = (u) => {
  const [file, hash] = u.split('#');
  if (specFiles.includes(file)) return `${specPage(file)}${hash ? `#${hash}` : ''}`;
  if (file === '../guides/docking.md') return '/dock';
  return u;
};
await mkdir(P('public', 'rnd'), { recursive: true });
for (const file of specFiles) {
  const { title, titleHtml, html, headings } = markdown(await readFile(P('specs', file), 'utf8'), { link: specLink });
  const [name, subtitle] = title.split(/:\s*/, 2);
  const contents = headings.filter((h) => h.level === 2).map((h) => `<li><a href="#${h.id}">${h.text}</a></li>`).join('');
  const rnd = places.find((p) => p.id === 'rnd');
  const page = layout
    .replace('{{title}}', esc(`${title} · TIMDA`))
    .replace('{{description}}', esc(`${name}, a TIMDA specification: ${subtitle}.`))
    .replace('{{header}}', TOP_BAR)
    .replace('{{heading}}', directory('rnd'))
    .replace('{{directory}}', `    <p class="deck-label">${esc(rnd.deck)} · <a href="/rnd">${esc(rnd.name)}</a></p>\n    <h1 class="place spec-title">${titleHtml}</h1>`)
    .replace('{{body}}', [
      '    <article class="shoot spec">',
      // the spec's status table first (if it opens with one), then the contents
      indent(html.replace(/^(<div class="table-scroll"[^>]*>[^]*?<\/div>\n)?/, (lead) => `${lead}<details class="rollup spec-contents"><summary><h2>Contents</h2></summary><ol>${contents}</ol></details>\n`), 6),
      `      <p class="spec-licence">${esc(name)} is published under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>: copy it, adapt it, build on it, with credit to timda.space. <a href="/rnd">All the specs</a>.</p>`,
      '    </article>',
    ].join('\n'));
  const out = `${specPage(file).slice(1)}.html`;
  await writeFile(P('public', out), await stampAssets(page));
  built.push(out);
}

// Every place needs a page.
for (const p of places) {
  const out = p.slug === '' ? 'index.html' : `${p.slug}.html`;
  if (!built.includes(out)) throw new Error(`place "${p.id}" has no page (expected pages/${p.slug || 'arrivals'}.html)`);
}
console.log(`built ${built.length} pages (style.css?v=${cssVersion}, ${assetVersions.size} images): ${built.join(', ')}`);
