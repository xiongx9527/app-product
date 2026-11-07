import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, join, normalize } from 'node:path'

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
    let body: Buffer | string = buf
    // index.html 与 swagger-initializer.js 里都写死了 petstore 的 demo 地址，统一改成我们的
    // /api/openapi.json，否则 Swagger UI 拉不到契约、页面空白。
    if (ext === '.html' || ext === '.js') {
      body = buf.toString().replace(/url:\s*["'][^"']+["']/, "url: '/api/openapi.json'")
    }
    return { status: 200, contentType: MIME[ext] ?? 'application/octet-stream', body }
  } catch {
    return null
  }
}
