// Takes the demo screenshots into docs/screenshots/ using the installed Edge (no browser download).
//   1. start the app:  .venv\Scripts\python -m uvicorn api:app --port 8000
//   2. cd web; npm run screenshots
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8000';
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'screenshots');
mkdirSync(OUT, { recursive: true });

const shots = [
  { name: 'landing', url: '/' },
  { name: '2005', url: '/?year=2005' },
  { name: '2014', url: '/?year=2014' },
  { name: '2018', url: '/?year=2018' },
  { name: '2018-all-links', url: '/?year=2018&all=1' },
  { name: '2007-where-editors-fought', url: '/?year=2007&metric=controversy' },
  { name: '2013-what-was-rewritten', url: '/?year=2013&metric=rewritten' },
  { name: 'story-1918-2014', url: '/?story=1&year=2014' },
  { name: 'place-tampere-2018', url: '/?year=2018&place=Tampere' },
  { name: 'sql-drawer', url: '/?year=2014&sql=arcs' },
];
const only = process.argv.slice(2);

const browser = await chromium.launch({
  channel: process.env.CHANNEL || 'msedge',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('  console error:', m.text()); });
page.on('pageerror', (e) => console.log('  page error:', e.message));
for (const s of shots) {
  if (only.length && !only.some((o) => s.name.includes(o))) continue;
  await page.goto(BASE + s.url);
  await page.waitForFunction(() => window.__app && window.__app.ready(), null, { timeout: 30000 });
  await page.waitForTimeout(5000);     // camera flight, textures, arc animation
  await page.screenshot({ path: path.join(OUT, `${s.name}.png`) });
  console.log('saved', s.name);
}
await browser.close();
