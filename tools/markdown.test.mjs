import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inline, markdown } from './markdown.mjs';

test('inline: code untouched, then links, bold, italics; HTML escaped', () => {
  assert.equal(inline('`a*b*<c>` and *next*, **bold**, [TIMDA-2](0002.md), x\\|y', (u) => `/r/${u}`),
    '<code>a*b*&lt;c&gt;</code> and <em>next</em>, <strong>bold</strong>, <a href="/r/0002.md">TIMDA-2</a>, x|y');
  assert.equal(inline('*WSP ";" *WSP'), '*WSP &quot;;&quot; *WSP'); // a lone star isn't italics
});

test('blocks: title, headings with ids, lists (nested, numbered across blank lines), tables, code', () => {
  const { title, titleHtml, html, headings } = markdown([
    '# TIMDA-9: The `_x` records', '', '| | |', '| --- | --- |', '| **Status** | Draft |', '',
    '## 2.1 Keeping it consistent', '', 'One line', 'continued.', '',
    '1. first', '   - nested', '', '2. second', '', '- a', '- b', '',
    '| Name | Holds |', '| --- | --- |', '| `_x.<d>` | `a` \\| `b` |', '',
    '```', 'v=TIMDA1; <x>', '```',
  ].join('\n'));
  assert.equal(title, 'TIMDA-9: The _x records');
  assert.equal(titleHtml, 'TIMDA-9: The <code>_x</code> records');
  assert.deepEqual(headings, [{ level: 2, id: '2-1-keeping-it-consistent', text: '2.1 Keeping it consistent' }]);
  assert.match(html, /^<div class="table-scroll" tabindex="0" role="region" aria-label="Table 1"><table><tbody>\n<tr><td><strong>Status<\/strong><\/td><td>Draft<\/td><\/tr>/); // no header row
  assert.match(html, /<p>One line continued\.<\/p>/);
  assert.match(html, /<ol><li>first<ul><li>nested<\/li><\/ul><\/li><li>second<\/li><\/ol>\n<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(html, /<thead><tr><th scope="col">Name<\/th><th scope="col">Holds<\/th><\/tr><\/thead>/);
  assert.match(html, /<td><code>a<\/code> \| <code>b<\/code><\/td>/);
  assert.match(html, /<pre tabindex="0"><code>v=TIMDA1; &lt;x&gt;<\/code><\/pre>$/);
});
