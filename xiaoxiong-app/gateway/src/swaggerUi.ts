import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, normalize } from 'node:path'

const require = createRequire(import.meta.url)
const distDir = dirname(require.resolve('swagger-ui-dist/package.json'))

const MIME: Record<string, string> = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.png': 'image/png',
  '.json': 'application/json',
}

/** 从 swagger-ui-dist 提供 Swagger UI 静态资源，并把默认 spec 指向 /api/openapi.json。 */
export async function serveSwagger(pathname: string): Promise<{ status: number; contentType: string; body: Buffer | string } | null> {
  let rel = pathname.replace(/^\/docs/, '') || '/'
  if (rel === '/') rel = '/index.html'
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '')
  const filePath = join(distDir, safe)
  if (!filePath.startsWith(distDir)) return null
  try {
    const buf = await readFile(filePath)
    const ext = extname(filePath)
    const name = basename(filePath)
    let body: Buffer | string = buf
    // swagger-ui-dist 自带的 swagger-initializer.js 写死了 petstore 的 demo 地址，必须改成我们的
    // /api/openapi.json，否则 Swagger UI 拉不到契约、页面空白。
    // 注意：只能针对这「一个」文件改写——swagger-ui-bundle.js 等库文件内部也含 `url:` 样式的
    // 代码，盲目替换会破坏 bundle（之前就是这么把包改坏导致页面空白的）。
    if (name === 'swagger-initializer.js') {
      body = buf.toString().replace(/url:\s*["'][^"']+["']/, "url: '/api/openapi.json'")
    }
    return { status: 200, contentType: MIME[ext] ?? 'application/octet-stream', body }
  } catch {
    return null
  }
}
