// Just enough Markdown for the TIMDA specs, at build time (browsers get plain HTML):
// headings (with ids), paragraphs, bullet and numbered lists (nested by indent),
// tables (with \| for a literal bar), fenced code, `code`, **bold**, *italic* and
// [links](url). No dependencies; anything fancier, keep out of the specs.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** An id for a heading: "2.1 Keeping the pieces consistent" -> "2-1-keeping-the-pieces-consistent". */
export const slug = (text) => text.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Inline markup. `link` rewrites link targets (e.g. sibling specs to their pages). */
export function inline(text, link = (u) => u) {
  // Code spans first, so nothing inside them is touched.
  return text.split(/(`[^`]*`)/).map((part) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) return `<code>${esc(part.slice(1, -1))}</code>`;
    return esc(part.replace(/\\\|/g, '|'))
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${esc(link(u.replace(/&amp;/g, '&')))}">${t}</a>`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, '$1<em>$2</em>');
  }).join('');
}

const LIST_RE = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const cells = (row) => row.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim());

/** Render a run of list lines (items, and continuation lines) as nested <ul>/<ol>. */
function renderList(lines, link) {
  const items = [];
  for (const line of lines) {
    const m = LIST_RE.exec(line);
    if (m) items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), start: parseInt(m[2], 10), text: m[3] });
    else items.at(-1).text += ` ${line.trim()}`; // a wrapped line belongs to the item above
  }
  const build = (first, indent) => {
    const tag = items[first].ordered ? 'ol' : 'ul';
    const out = [];
    let i = first;
    while (i < items.length && items[i].indent >= indent) {
      if (items[i].indent > indent) { i++; continue; }
      let html = inline(items[i].text, link);
      let j = i + 1;
      if (j < items.length && items[j].indent > indent) {
        const [child, next] = build(j, items[j].indent);
        html += child;
        j = next;
      }
      out.push(`<li>${html}</li>`);
      i = j;
    }
    const n = items[first].start;
    return [`<${tag}${tag === 'ol' && n > 1 ? ` start="${n}"` : ''}>${out.join('')}</${tag}>`, i];
  };
  return build(0, items[0].indent)[0];
}

/**
 * Markdown to HTML. Returns { title, titleHtml, html, headings }: the first # heading is
 * the title (left out of the html), headings are [{ level, id, text }] for a contents list.
 */
export function markdown(src, { link } = {}) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const headings = [];
  let title;
  let titleHtml;
  let tables = 0; // scrollable regions need distinct names
  let i = 0;
  const para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '), link)}</p>`); para.length = 0; } };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const code = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      out.push(`<pre tabindex="0"><code>${esc(code.join('\n'))}</code></pre>`); // focusable: it may scroll
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      const text = inline(h[2], link);
      if (level === 1 && title === undefined) { title = h[2].replace(/`/g, ''); titleHtml = text; i++; continue; }
      const id = slug(text);
      headings.push({ level, id, text });
      out.push(`<h${level} id="${id}">${text}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*\|/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      flush();
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(cells(lines[i]));
      const th = head.map((c) => `<th scope="col">${inline(c, link)}</th>`).join('');
      const tr = rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, link)}</td>`).join('')}</tr>`).join('\n');
      // A header row of blanks is a key/value table with no headings.
      out.push(`<div class="table-scroll" tabindex="0" role="region" aria-label="Table ${++tables}"><table>${head.every((c) => !c) ? '' : `<thead><tr>${th}</tr></thead>`}<tbody>\n${tr}\n</tbody></table></div>`);
      continue;
    }
    if (LIST_RE.test(line)) {
      flush();
      const block = [];
      for (;;) {
        while (i < lines.length && lines[i].trim() && (LIST_RE.test(lines[i]) || /^\s+\S/.test(lines[i]))) block.push(lines[i++]);
        // A blank line between items doesn't end the list (or restart its numbering).
        let j = i;
        while (j < lines.length && !lines[j].trim()) j++;
        const top = LIST_RE.exec(block[0]);
        const next = j > i && j < lines.length ? LIST_RE.exec(lines[j]) : null;
        const sameList = next && (next[1].length > top[1].length || /\d/.test(next[2]) === /\d/.test(top[2]));
        if (sameList) { i = j; continue; }
        break;
      }
      out.push(renderList(block, link));
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    para.push(line.trim());
    i++;
  }
  flush();
  return { title, titleHtml, html: out.join('\n'), headings };
}
