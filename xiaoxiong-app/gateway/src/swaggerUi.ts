import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, normalize } from 'node:path'

const require = createRequire(import.meta.url)

// 离线包里没有 node_modules，模块顶层 require.resolve 会直接抛错导致整个 bundle 起不来。
// 延迟到真正请求 /docs 时才解析；解析失败（或 DOCS_ENABLED=false）就禁用文档，其余接口不受影响。
let distDir: string | null | undefined
function resolveDistDir(): string | null {
  if (distDir !== undefined) return distDir
  if (process.env.DOCS_ENABLED === 'false') return (distDir = null)
  try {
    distDir = dirname(require.resolve('swagger-ui-dist/package.json'))
  } catch {
    distDir = null
  }
  return distDir
}

const MIME: Record<string, string> = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.png': 'image/png',
  '.json': 'application/json',
}

/** 从 swagger-ui-dist 提供 Swagger UI 静态资源，并把默认 spec 指向 /api/openapi.json。 */
export async function serveSwagger(pathname: string): Promise<{ status: number; contentType: string; body: Buffer | string } | null> {
  const root = resolveDistDir()
  if (!root) return null
  let rel = pathname.replace(/^\/docs/, '') || '/'
  if (rel === '/') rel = '/index.html'
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '')
  const filePath = join(root, safe)
  if (!filePath.startsWith(root)) return null
  try {
    const buf = await readFile(filePath)
    const ext = extname(filePath)
    const name = basename(filePath)
    let body: Buffer | string = buf
    // /docs 没有结尾斜杠时，浏览器会把 index.html 里的相对资源 ./swagger-ui-bundle.js 解析到
    // 站点根目录（/swagger-ui-bundle.js → 404），整页空白。注入 <base> 让所有相对路径
    // 始终落到 /docs/ 下，无论用户访问 /docs 还是 /docs/。
    if (ext === '.html') {
      // <base> 必须放在 <head> 开头，才能对后面的 CSS/JS 链接生效；放在 </head> 前则只对它
      // 之后的标签生效，而 CSS 链接已经在它前面，会导致样式加载失败（页面「没样式」）。
      body = buf.toString().replace('<head>', '<head><base href="/docs/">')
    } else if (name === 'swagger-initializer.js') {
      // swagger-ui-dist 自带的 swagger-initializer.js 写死了 petstore 的 demo 地址，改成我们的
      // /api/openapi.json；只针对这「一个」文件改写——库文件内部也含 `url:` 代码，盲目替换
      // 会破坏 bundle（之前就是这么把包改坏导致页面空白的）。
      body = buf.toString().replace(/url:\s*["'][^"']+["']/, "url: '/api/openapi.json'")
    }
    return { status: 200, contentType: MIME[ext] ?? 'application/octet-stream', body }
  } catch {
    return null
  }
}
