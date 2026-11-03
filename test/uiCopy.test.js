import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const html = readFileSync('public/index.html', 'utf8');

const SUBTITLE = "View research, explore related themes, and discover patterns across UBC's theses and dissertations from 1919 onward. Note that theses and dissertations continue to be indexed, and the catalogue here is not a complete representation of those held by cIRcle, made available through Open Collections.";
const NOTICE = 'Connections between people and theses and dissertations have been reconstructed from statements in the documents themselves. Where authoritative metadata exists indicating the dissertation or thesis supervisor, that metadata takes precedence here. However, supervisor metadata is only available from 2018 onward in UBCV manuscripts, based on sampling.';

test('hero subtitle is the owner\'s text', () => {
  assert.ok(html.includes(`<p class="subtitle">${SUBTITLE}</p>`));
});

test('people notice sits under the filter row', () => {
  const re = new RegExp(`people-filter-row[\\s\\S]*?</div>\\s*<p id="peopleProvenanceNotice"[^>]*>${NOTICE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</p>`);
  assert.match(html, re);
});

const ALLOW = /Dissertation Workbench|theses and dissertations|thesis and dissertation|dissertation or thesis|\.dissertations\b|(^|[{,])\s*dissertations:|dissertations\.(bib|ris)|^\s*(\/\/|\*)/;

function isFlagged(line) {
  return /\bdissertations?\b/i.test(line) && !ALLOW.test(line);
}

test('copy scan flags visible labels but allows object keys', () => {
  assert.equal(isFlagged('<p><strong>Linked dissertations:</strong> 3</p>'), true);
  assert.equal(isFlagged('    dissertations: supervised,'), false);
});

test('no user-visible "dissertation" outside the allow-list', () => {
  const files = [
    'public/index.html',
    ...readdirSync('public/app').filter((f) => f.endsWith('.js')).map((f) => `public/app/${f}`),
    'src/services/themeJobRunner.js',
  ];
  const bad = [];
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (isFlagged(line)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, []);
});

test('tool name is kept', () => {
  assert.ok(html.includes('<title>Dissertation Workbench</title>'));
  assert.ok(html.includes('<h1>Dissertation Workbench</h1>'));
});
