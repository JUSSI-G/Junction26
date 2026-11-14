// The demo path, end to end, against the running app (real API), with timings:
//   worklist -> search "sisällissota" -> list -> article (Languages, Edit wars) -> map -> click a dot
//   1. .venv\Scripts\python -m uvicorn api.main:app --port 8000
//   2. cd web; node scripts/demo-flow.mjs        -> docs/screenshots/demo-*.png, timings printed
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const BASE = process.env.BASE || 'http://127.0.0.1:8000'
const Q = process.env.QUERY || 'sisällissota'
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'screenshots')
mkdirSync(OUT, { recursive: true })
const timings = []
const time = async (label, fn) => {
  const t = performance.now()
  const r = await fn()
  const ms = Math.round(performance.now() - t)
  timings.push([label, ms])
  console.log(`${label.padEnd(44)} ${String(ms).padStart(6)} ms`)
  return r
}
const shot = async (page, name) => { await page.screenshot({ path: path.join(OUT, `demo-${name}.png`) }); console.log('  saved', `demo-${name}.png`) }
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1 }

const browser = await chromium.launch({ channel: process.env.CHANNEL || 'msedge' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
page.on('pageerror', (e) => fail(`page error: ${e.message}`))

// 0. landing = the worklist
await time('landing: worklist rendered', async () => {
  await page.goto(`${BASE}/`)
  await page.waitForSelector('table.wl2 tbody tr')
})
if (!page.url().includes('/contested/')) fail(`/ did not redirect to the editor app: ${page.url()}`)
await shot(page, '1-worklist')

// 1. semantic search
await time(`semantic search "${Q}" -> list`, async () => {
  await page.fill('.search input', Q)
  await page.press('.search input', 'Enter')
  await page.waitForFunction(() => document.querySelector('.chiprow .status')?.innerText.includes('embedded'))
  await page.waitForSelector('.worklist2:not(.stale) table.wl2 tbody tr')
})
const top = await page.$$eval('table.wl2 tbody tr .art a', (as) => as.slice(0, 5).map((a) => a.innerText))
console.log('  top results:', top.join(' | '))
if (!top.includes('Suomen sisällissota')) fail('Suomen sisällissota not in the top 5')
await shot(page, '2-search')

// 1b. SQL drawer on the search
await page.click('.sqltoggle')
await page.waitForSelector('.sqlcontent pre')
await shot(page, '2b-search-sql')
await page.click('.sqltoggle')

// 1c. a topic chip (WITH RECURSIVE)
await time('topic chip "Civil War 1918"', async () => {
  await page.click('.search .clear')
  await page.waitForFunction(() => !document.querySelector('.search input').value)
  await page.click('.topic:has-text("Civil War 1918")')
  await page.waitForFunction(() => document.querySelector('.chiprow .status')?.innerText.match(/^\d+ article/))
})
await shot(page, '3-chip')

// 2. article page, Languages tab
await time('open article -> Languages tab', async () => {
  await page.click('table.wl2 tbody tr:has-text("Suomen sisällissota")')
  await page.waitForSelector('.cmprow .cell')
})
const agreed = await page.$$eval('.contras li', (li) => li.map((x) => x.classList.contains('agree')))
console.log(`  contradictions panel: ${agreed.length}, both models agree: ${agreed.filter(Boolean).length}`)
if (agreed.length && !agreed[0]) fail('"both models agree" not first')
await shot(page, '4-article-languages')

// 3. Edit wars tab
await time('Edit wars tab', async () => {
  await page.click('.arttabs a:has-text("Edit wars")')
  await page.waitForSelector('.war')
})
await shot(page, '5-article-editwars')
await time('Edit wars -> Contested sentences', async () => {
  await page.click('.subtabs button:has-text("Contested sentences")')
  await page.waitForSelector('.prose .s')
})
await shot(page, '6-article-contested')
await time('Edit wars -> Article on a date', async () => {
  await page.click('.subtabs button:has-text("Article on a date")')
  await page.waitForSelector('.sliders input[type=range]')
})
await shot(page, '7-article-asof')

// 4. map, with the semantic search
await time(`map for "${Q}"`, async () => {
  await page.goto(`${BASE}/contested/#/map?q=${encodeURIComponent(Q)}`)
  await page.waitForFunction(() => document.querySelector('.maplegend')?.innerText.match(/[1-9][\d,]* articles on the map/))
})
await page.waitForTimeout(900)            // the fit animation
await shot(page, '8-map-search')

// 5. click a dot: the civil war's own dot
const box = await page.$eval('.mapwrap canvas', (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })
// where the map drew the civil war's dot (window.__map), then a real hover and click there
let found = null
await time('hover the civil war dot', async () => {
  const p = await page.evaluate(() => { const d = window.__map.dots.find((x) => x.id === 'Q211855'); return d && { x: d.sx, y: d.sy } })
  if (!p) return
  await page.mouse.move(box.x + p.x, box.y + p.y)
  await page.waitForSelector('.maptip')
  if ((await page.$eval('.maptip b', (b) => b.innerText)) === 'Suomen sisällissota') found = { x: box.x + p.x, y: box.y + p.y }
})
await shot(page, '8b-map-hover')
if (!found) fail('civil war dot not found on the map')
else {
  await time('click dot -> 10 similar articles + lines', async () => {
    await page.mouse.click(found.x, found.y)
    await page.waitForSelector('.mapcard .simlist li')
  })
  await page.waitForTimeout(600)          // line draw-in
  await shot(page, '9-map-dot')
  const frame = await page.$eval('.maplegend', (e) => e.innerText.match(/frame ([\d.]+) ms/)?.[1])
  console.log(`  map frame time: ${frame} ms`)
  // hover another dot while the first is pinned (<= 20 lines on screen)
  await page.mouse.move(found.x + 60, found.y + 40)
  await page.waitForTimeout(500)
  await time('map card name -> article page', async () => {
    await page.click('.mapcard .title')
    await page.waitForSelector('.cmprow .cell')
  })
}

// 6. the whole map, no filter
await time('map, all articles', async () => {
  await page.goto(`${BASE}/contested/#/map`)
  // "2,682" or "2 682": the browser's locale decides the thousands separator
  await page.waitForFunction(() => document.querySelector('.maplegend')?.innerText.match(/\d[\d,\s]{3,} articles on the map/))
})
await page.waitForTimeout(900)
await shot(page, '10-map-all')

console.log('\ntimings (ms):', JSON.stringify(Object.fromEntries(timings)))
await browser.close()
