import pkg from '/Users/xiongxiao/.npm/_npx/13ab0715f9f30c2e/node_modules/playwright/index.js'
const { chromium } = pkg
const BASE = 'http://localhost:5173'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const results = []
const check = (n, c, d = '') => { results.push({ n, ok: !!c }); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  -> ' + d : ''}`) }

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const ctx = await browser.newContext({ hasTouch: true })
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message))

const rect = (sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) } }).catch(() => null)

// ---- 横屏平板 1180x820 ----
await page.setViewportSize({ width: 1180, height: 820 })
await page.goto('about:blank')
await page.goto(`${BASE}/#/pages/mcpservers/mcpservers`)
await page.waitForSelector('.add-link', { timeout: 5000 })
await page.waitForTimeout(400)

let p = await rect('.page')
const vw = 1180
check('横屏：.page 限宽（约680，不铺满）', p && p.w <= 700 && p.w >= 600, `w=${p?.w}`)
check('横屏：.page 居中（左右有留白）', p && p.x > 50, `x=${p?.x}`)
let nav = await rect('.nav-bar')
check('横屏：导航栏跟随内容列宽度', nav && Math.abs(nav.w - p.w) < 4, `nav.w=${nav?.w} page.w=${p?.w}`)

// 进入编辑，检查底部操作栏居中
await page.click('.add-link')
await page.waitForSelector('.action-bar')
await page.waitForTimeout(300)
let ab = await rect('.action-bar')
check('横屏：操作栏限宽居中', ab && ab.w <= 700 && ab.x > 50, `w=${ab?.w} x=${ab?.x}`)

// ---- 竖屏手机 390x844（不应限宽）----
await page.setViewportSize({ width: 390, height: 844 })
await page.goto('about:blank')
await page.goto(`${BASE}/#/pages/mcpservers/mcpservers`)
await page.waitForSelector('.add-link', { timeout: 5000 })
await page.waitForTimeout(400)
let p2 = await rect('.page')
check('竖屏：.page 铺满（不限宽）', p2 && p2.w > 360 && p2.x < 5, `w=${p2?.w} x=${p2?.x}`)

await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
process.exit(failed.length ? 1 : 0)
