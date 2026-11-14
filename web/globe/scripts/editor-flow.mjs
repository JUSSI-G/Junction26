// The demo path, end to end, against the running app (real API, no mocks):
//   globe (language differences) -> hover + click the 1918 war's line to London -> /contested/#compare/Q211855
//   -> real rows, Gemma labels, "both models agree" contradictions first.
//   1. .venv\Scripts\python -m uvicorn api.main:app --port 8000
//   2. cd web/globe; node scripts/editor-flow.mjs          (screenshots into docs/screenshots/editor-flow-*.png)
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8000';
const Q = process.env.TOPIC || 'Q211855';
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'screenshots');
mkdirSync(OUT, { recursive: true });
const shot = async (page, name) => { await page.screenshot({ path: path.join(OUT, `editor-flow-${name}.png`) }); console.log('saved', name); };
const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1; };

const browser = await chromium.launch({
  channel: process.env.CHANNEL || 'msedge',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('  page error:', e.message));

// 0. the full picture first
await page.goto(`${BASE}/globe/?year=2026&metric=language`);
await page.waitForFunction(() => window.__app && window.__app.ready(), null, { timeout: 30000 });
await page.waitForTimeout(5000);
await shot(page, '0-globe-language');

// 1. globe, language differences, focused on the topic
await page.goto(`${BASE}/globe/?year=2026&metric=language&topic=${Q}`);  // only this topic's lines: 9 topics share its point
await page.waitForFunction(() => window.__app && window.__app.ready(), null, { timeout: 30000 });
await page.waitForTimeout(5000);
const topic = await page.evaluate(async (q) => (await (await fetch('/api/lang-lines')).json()).data.find((t) => t.wikidata_id === q), Q);
if (!topic) throw new Error(`${Q} has no line on the globe`);

// 2. find the topic's English line: walk the screen segment from the article to London, and from each
//    point upwards (the arc bows away from the globe), hovering until globe.gl's tooltip is the line's
//    own ("en distance …" without "sv": the dot's tooltip lists both languages).
const LONDON = { lat: 51.507, lon: -0.128 };
const [a, b] = await page.evaluate(([t, l]) => [window.__app.globe.getScreenCoords(t.lat, t.lon, 0),
  window.__app.globe.getScreenCoords(l.lat, l.lon, 0)], [topic, LONDON]);
const lineTip = async () => page.evaluate(() => [...document.querySelectorAll('.float-tooltip-kap')].map((e) => e.innerText).join(' '));
let hit = null;
for (let f = 0.5; f <= 0.9 && !hit; f += 0.05) {
  for (let up = 0; up <= 260; up += 3) {
    const xy = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f - up };
    if (xy.x < 0 || xy.y < 0 || xy.x > 1600 || xy.y > 900) continue;
    await page.mouse.move(xy.x, xy.y);
    await page.waitForTimeout(25);
    const tip = await lineTip();
    if (tip.includes(topic.titles.fi) && tip.includes('en distance') && !tip.includes('sv distance')) { hit = xy; break; }
  }
}
if (hit) {
  await shot(page, '1-globe-line-hover');
  await Promise.all([page.waitForURL(/#compare\//, { timeout: 15000 }), page.mouse.click(hit.x, hit.y)]);
} else {
  fail(`could not hover the ${Q} line; opening the compare view directly`);
  await page.goto(`${BASE}/contested/#compare/${Q}`);
}

// 3. compare view with real data
console.log('at', page.url());
await page.waitForSelector('.cmprow .cell', { timeout: 20000 }).catch(async (e) => { await shot(page, 'x-failed'); throw e; });
await page.waitForTimeout(800);
const url = page.url();
if (!url.includes(`#compare/${Q}`)) fail(`landed on ${url}`);
const check = await page.evaluate(() => ({
  mock: !!document.querySelector('.mocknote'),
  title: document.querySelector('.cmptitle h2')?.innerText,
  rows: document.querySelectorAll('.cmpgrid .cmprow').length - 1,
  contradictions: [...document.querySelectorAll('.contras li')].map((li) => li.classList.contains('agree')),
  labels: document.querySelectorAll('.cell .stag').length,
}));
console.log('compare:', JSON.stringify({ ...check, contradictions: check.contradictions.length, agreed: check.contradictions.filter(Boolean).length }));
if (check.mock) fail('mock data shown');
if (check.rows < 100) fail(`only ${check.rows} rows`);
const firstNotAgreed = check.contradictions.indexOf(false);
if (!check.contradictions.length || !check.contradictions[0]) fail('no "both models agree" contradiction first');
if (firstNotAgreed >= 0 && check.contradictions.slice(firstNotAgreed).some(Boolean)) fail('agreed contradictions not all first');
await shot(page, '2-compare');

// 4. click the first (agreed) contradiction: jumps to its row and opens the fix panel
await page.click('.contras li');
await page.waitForSelector('.fix', { timeout: 5000 });
await page.evaluate(() => window.scrollBy(0, -60));
await page.waitForTimeout(800);
await shot(page, '3-contradiction-row');

// 5. hover a judged cell for Gemma's reasons (both models)
const cell = page.locator('.cmprow.sel .cell.contradiction').first();
if (await cell.count()) { await cell.hover(); await page.waitForTimeout(400); await shot(page, '4-gemma-reasons'); }
await browser.close();
