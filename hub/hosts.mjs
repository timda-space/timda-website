// The Observation Lounge's hosts: four original characters who introduce each banner.
// Their portraits are 16x16 pixel maps in the station palette, drawn as inline SVG
// (no image files, nothing to cache). One letter per pixel:
//   .  nothing       s  steel      W  cream     c  cyan      a  amber
//   p  peri          m  mid blue   d  deep      k  space     w  white

const COLORS = {
  s: '#a3b8ce', W: '#e1e3d6', c: '#84dee4', a: '#e27a4e',
  p: '#7590c1', m: '#38548c', d: '#1b2c54', k: '#161d2e', w: '#faf9f2',
};

const SPRITES = {
  robot: [
    '.......aa.......',
    '.......ss.......',
    '..ssssssssssss..',
    '..sWWWWWWWWWWs..',
    '..sWccWWWWccWs..',
    '..sWcwWWWWcwWs..',
    '..sWWWWWWWWWWs..',
    '..sWWkkkkkkWWs..',
    '..sWWkWkWkWWWs..',
    '..sWWWWWWWWWWs..',
    '..ssssssssssss..',
    '.....aa..aa.....',
    '......aaaa......',
    '.....aa..aa.....',
    '..pppppppppppp..',
    '.pppppppppppppp.',
  ],
  sage: [
    '................',
    '.ssssssssssssss.',
    '.sddddddddddddsk',
    '.sddddddddddddsk',
    '.sdddccddccdddsk',
    '.sdddccddccdddsk',
    '.sddddddddddddsk',
    '.sddddddddddddsk',
    '.sddddcccccdddsk',
    '.sdddddddddcddsk',
    '.sddddddddddddsk',
    '.ssssssssssssssk',
    '..kkkkkkkkkkkkkk',
    '......mmmm......',
    '....mmmmmmmm....',
    '...ssssssssss...',
  ],
  alien: [
    '...a........a...',
    '....p......p....',
    '.....pppppp.....',
    '...pppppppppp...',
    '..ppWWWWWWWWpp..',
    '..ppWWkkkkWWpp..',
    '..ppWWkckkWWpp..',
    '..ppWWkkkkWWpp..',
    '..ppWWWWWWWWpp..',
    '..pppppppppppp..',
    '..pppkkkkkkppp..',
    '...pppppppppp...',
    '..p.p.p..p.p.p..',
    '.p..p..pp..p..p.',
    '.p...p....p...p.',
    '................',
  ],
  bix: [
    '................',
    '.....mmmmmm.....',
    '....mmmmmmmm....',
    '...mccmmmmccm...',
    '...mccmmmmccm...',
    '...WWWWWWWWWW...',
    '...WWkWWWWkWW...',
    '...WWWWWWWWWW...',
    '...WWWWWWWWWW...',
    '...WWWkkkkWWW...',
    '....WWWWWWWW....',
    '...pppppppppp...',
    '..pppppppppppss.',
    '..pppaapppppsWs.',
    '..pppaappppppss.',
    '..pppppppppppp..',
  ],
};

/** A 16x16 pixel map as inline SVG: one rect per run of a colour along a row. */
function svg(rows) {
  if (rows.length !== 16 || rows.some((r) => r.length !== 16)) throw new Error('sprites are 16x16');
  const rects = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < 16;) {
      const ch = row[x];
      let w = 1;
      while (x + w < 16 && row[x + w] === ch) w++;
      if (ch !== '.') {
        if (!COLORS[ch]) throw new Error(`unknown sprite colour ${ch}`);
        rects.push(`<rect x="${x}" y="${y}" width="${w}" height="1" fill="${COLORS[ch]}"/>`);
      }
      x += w;
    }
  });
  return `<svg class="host-portrait" viewBox="0 0 16 16" width="64" height="64" shape-rendering="crispEdges" aria-hidden="true">${rects.join('')}</svg>`;
}

// {name} is the Section's name, {caption} its caption. Lines with {caption} are only
// used when there is one. All values are escaped before they're put in.
export const HOSTS = [
  {
    id: 'robot', name: 'Courtesy Unit 7', role: 'Lounge steward',
    caption: [
      'Good evening! Might I direct sir, madam or other to {name}? In their own words: “{caption}” I am contractually delighted.',
      'A thousand apologies for the interruption. A thousand and one, in fact. {name} wishes you to know: “{caption}”',
    ],
    plain: [
      'Good evening! Might I direct sir, madam or other to {name}? I have been told it is excellent. I have been told to say that.',
      'Today’s great idea is {name}. I am not permitted an opinion, but if I were, it would be a positive one, as required.',
    ],
  },
  {
    id: 'sage', name: 'SAGE', role: 'Ambient intelligence, IQ 6,000 (self-assessed)',
    caption: [
      'Today’s great idea: {name}. They say: “{caption}” I’d have phrased it better. I’d have phrased everything better.',
      'Scanning… {name}. Slogan on file: “{caption}” Calculating whether that’s a good idea. Still calculating. It’s been a while.',
    ],
    plain: [
      'Today’s great idea: {name}. I’ve given it a lot of thought. Well, some thought. A thought.',
      'Scanning… {name}. No slogan on file. Brave. Or an oversight. I have no way of knowing, which is, frankly, unprecedented.',
    ],
  },
  {
    id: 'alien', name: 'Glim’varr', role: 'Tourist, 300 cycles in this lounge',
    caption: [
      'I rate {name} four tentacles out of five. Their slogan: “{caption}” Delicious. Do not ask how I know.',
      'We have a saying on my homeworld: “{caption}” We say it louder, and while molting. {name}. Go. I will watch your seat.',
    ],
    plain: [
      'I rate {name} four tentacles out of five. The fifth tentacle is still deciding. It is a slow tentacle.',
      '{name}. I have been there. Or I have eaten it. My memory of that cycle is moist.',
    ],
  },
  {
    id: 'bix', name: 'Bix', role: 'Maintenance, on break',
    caption: [
      'Look, there’s this place, {name}. It says “{caption}” Seems alright. Don’t tell my supervisor I recommended anything.',
      'I’m on break, so I’m not officially telling you about {name}. Their whole thing: “{caption}” Right, back to not working.',
    ],
    plain: [
      'There’s a place called {name}. Haven’t been. Can’t leave the lounge, technically on shift. Technically on break. It’s complicated.',
      'You want a great idea? {name}. You want a better one? Bring me a coffee. The machine’s been out since the launch.',
    ],
  },
].map((h) => ({ ...h, portrait: svg(SPRITES[h.id]) }));

/** A host's line for a Section, with values already escaped by the caller. */
export function hostLine(host, { name, caption }, rand = Math.random) {
  const lines = caption ? host.caption : host.plain;
  return lines[Math.floor(rand() * lines.length)].replaceAll('{name}', name).replaceAll('{caption}', caption ?? '');
}
