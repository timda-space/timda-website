// Render the TIMDA launch button (an 88x31 webring button) and the touch icon.
// Original art: the pixel station from favicon.svg plus Silkscreen text, not the
// station artwork (whose licence forbids derivatives).
//
//   node tools/render-badge.mjs
//
// Writes public/ring/timda-88x31.png, public/ring/timda-176x62.png (2x) and
// public/apple-touch-icon.png (180x180).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Same as render-map.mjs: Playwright from tools/ if installed there, else the global one.
const { chromium } = createRequire(new URL('./package.json', import.meta.url))('playwright');

const root = new URL('../public/', import.meta.url);
const font = (f) => `data:font/woff2;base64,${readFileSync(new URL(`fonts/${f}`, root)).toString('base64')}`;
const icon = `data:image/svg+xml;base64,${readFileSync(new URL('favicon.svg', root)).toString('base64')}`;
const out = (p) => fileURLToPath(new URL(p, root));

const css = `
@font-face { font-family: S; src: url(${font('silkscreen-400.woff2')}); font-weight: 400; }
@font-face { font-family: S; src: url(${font('silkscreen-700.woff2')}); font-weight: 700; }
* { margin: 0; box-sizing: border-box; }
html, body { background: transparent; }
img { image-rendering: pixelated; display: block; }
`;

const badge = `<!doctype html><style>${css}
#b { position: relative; width: 88px; height: 31px; background: #161d2e; overflow: hidden;
     /* a bevel: lit from the top left, shadowed bottom right in mid blue-grey */
     border: 1px solid; border-color: #7590c1 #38548c #38548c #7590c1;
     box-shadow: inset -1px -1px 0 #38548c; }
#b img { position: absolute; left: 1px; top: 8px; width: 16px; height: 16px; }
#t { position: absolute; left: 19px; top: 3px; font: 700 16px/16px S; color: #e1e3d6; }
#l { position: absolute; left: 20px; top: 19px; font: 400 8px/8px S; color: #e27a4e; }
#s1 { position: absolute; left: 84px; top: 3px; width: 1px; height: 1px; background: #faf9f2; }
#s2 { position: absolute; left: 77px; top: 25px; width: 1px; height: 1px; background: #84dee4; }
#s3 { position: absolute; left: 4px; top: 3px; width: 1px; height: 1px; background: #e27a4e; }
</style><div id="b"><img src="${icon}" alt=""><span id="t">TIMDA</span><span id="l">LAUNCH &gt;</span><i id="s1"></i><i id="s2"></i><i id="s3"></i></div>`;

const touch = `<!doctype html><style>${css}
#b { width: 180px; height: 180px; background: #161d2e; display: grid; place-items: center; }
#b img { width: 128px; height: 128px; }
</style><div id="b"><img src="${icon}" alt=""></div>`;

// The palette (concepts/look.md). Every pixel is snapped to it, which removes the
// blended corners where two border colours meet and the font's half-pixel slivers.
const PALETTE = ['#161d2e', '#1b2c54', '#38548c', '#7590c1', '#a3b8ce', '#e1e3d6', '#faf9f2', '#e27a4e', '#84dee4'];

const browser = await chromium.launch();
async function shot(html, sel, path, scale = 1, palette = PALETTE) {
  const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 400, height: 400 } });
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  const raw = (await page.locator(sel).screenshot()).toString('base64');
  const snapped = await page.evaluate(async ({ raw, palette }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${raw}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const pal = palette.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
    const d = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < d.data.length; i += 4) {
      let best = pal[0], dist = Infinity;
      for (const p of pal) {
        const e = (p[0] - d.data[i]) ** 2 + (p[1] - d.data[i + 1]) ** 2 + (p[2] - d.data[i + 2]) ** 2;
        if (e < dist) { dist = e; best = p; }
      }
      d.data.set(best, i);
    }
    ctx.putImageData(d, 0, 0);
    return c.toDataURL('image/png');
  }, { raw, palette });
  // Scale with nearest-neighbour, so the 2x is exactly the 1x with bigger pixels.
  const [w, h] = await page.locator(sel).evaluate((e) => [e.offsetWidth, e.offsetHeight]);
  await page.setContent(`<style>${css}</style><img id="x" src="${snapped}" style="width:${w * scale}px;height:${h * scale}px">`);
  await page.locator('#x').screenshot({ path });
  await page.close();
}
// The badge leaves out deep, so the bold D's half-pixel counter snaps to the background.
const BADGE = PALETTE.filter((c) => c !== '#1b2c54');
await shot(badge, '#b', out('ring/timda-88x31.png'), 1, BADGE);
await shot(badge, '#b', out('ring/timda-176x62.png'), 2, BADGE);
await shot(touch, '#b', out('apple-touch-icon.png'));
await browser.close();
console.log('wrote ring/timda-88x31.png, ring/timda-176x62.png, apple-touch-icon.png');
