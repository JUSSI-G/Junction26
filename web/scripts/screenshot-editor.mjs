// Screenshots of the editor views (worklist, comparison) for docs and review.
//   npm run dev            (in another terminal; editor views use mocks unless VITE_EDITOR_MOCKS=0)
//   node scripts/screenshot-editor.mjs [baseUrl] [outDir]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const base = process.argv[2] || 'http://localhost:5173/contested/'
const out = process.argv[3] || 'screenshots'
mkdirSync(out, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' })
page.on('pageerror', (e) => console.error('page error:', e.message))

// 1. Worklist, sorted by score.
await page.goto(`${base}#worklist`)
await page.waitForSelector('table.wl tbody tr')
await page.screenshot({ path: `${out}/editor-worklist.png`, fullPage: true })

// 2. Worklist with the SQL drawer open.
await page.click('.sqltoggle')
await page.screenshot({ path: `${out}/editor-worklist-sql.png` })
await page.click('.sqltoggle')

// 3. Click a row -> comparison view.
await page.click('table.wl tbody tr:has-text("Sauli Niinistö")')
await page.waitForSelector('.cmprow .cell')
await page.screenshot({ path: `${out}/editor-compare.png`, fullPage: true })

// 4. Hover a contradiction: Gemma's reason.
await page.hover('.cell.contradiction >> nth=0')
await page.screenshot({ path: `${out}/editor-compare-hover.png` })

// 5. Click that row: what to fix + Edit in Wikipedia buttons.
await page.click('.cell.contradiction >> nth=0')
await page.mouse.move(5, 5)
await page.waitForSelector('.fix')
const fix = await page.$('.fix')
await fix.scrollIntoViewIfNeeded()
await page.screenshot({ path: `${out}/editor-compare-fix.png` })

await browser.close()
console.log(`screenshots in ${out}/`)
