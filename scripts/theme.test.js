import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The top-bar switch sets html[data-theme]. Every dark rule must give way to a "light" pick and have a twin that a
// "dark" pick turns on, or that part of PINE ignores the switch.
const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const ON = ':root:not([data-theme="light"])', FORCE = ':root[data-theme="dark"]';
const flat = (s) => s.replace(/\s+/g, ' ').trim();

function darkBlocks() {
  const out = [];
  for (const m of css.matchAll(/@media \(prefers-color-scheme: dark\) \{/g)) {
    let i = m.index + m[0].length, depth = 1;
    while (depth) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; i++; }
    out.push(css.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

test('every dark-mode rule yields to a light pick and has a twin for a dark pick', () => {
  const blocks = darkBlocks();
  assert.ok(blocks.length > 0);
  const page = flat(css);
  for (const body of blocks) {
    for (const [, sel] of body.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
      for (const one of sel.split(/,(?![^(]*\))/)) assert.ok(one.trim().startsWith(ON), `not switchable: ${one.trim()}`);
    }
    assert.ok(page.includes(flat(body).split(ON).join(FORCE)), `no [data-theme="dark"] twin for: ${flat(body).slice(0, 80)}`);
  }
});

test('the page applies a saved pick before it draws', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /localStorage\.getItem\("pine-theme"\)/);
  assert.ok(html.indexOf('pine-theme') < html.indexOf('/app.js'), 'the theme script runs before the app');
});
