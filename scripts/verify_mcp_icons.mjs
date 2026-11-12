import pkg from '/Users/xiongxiao/.npm/_npx/13ab0715f9f30c2e/node_modules/playwright/index.js'
const { chromium } = pkg
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const URL = 'http://localhost:5173/#/pages/mcpservers/mcpservers'
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 390, height: 780 }, hasTouch: true })
const logs = []
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
const out = {}
await page.goto(URL, { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)

// 加两个服务器后取消，回到列表
await page.locator('.add-circle').first().tap()
await page.waitForTimeout(300)
await page.locator('.add-circle').first().tap()
await page.waitForTimeout(300)
await page.locator('.action-bar .btn-secondary').tap()
await page.waitForTimeout(500)

out.listRows = await page.locator('.list-row').count()
out.subGone = (await page.locator('.sub').count()) === 0
out.icons = await page.locator('.row-actions svg.ico').count() // 每行 2 个图标(编辑/删除) * 行数
out.switchCount = await page.locator('.list-row uni-switch').count()

// 截图
await page.screenshot({ path: '/Users/xiongxiao/Workspaces/Idea/codes/New/app-product/scripts/mcp_list.png', fullPage: false })
console.log(JSON.stringify(out, null, 2))
console.log('logs:', logs.join(' | '))
await browser.close()
