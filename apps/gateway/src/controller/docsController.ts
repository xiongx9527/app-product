import { serveSwagger } from '../swaggerUi'

export interface DocsResult {
  status: number
  contentType: string
  body: Buffer | string
}

/** 对外 Swagger UI 接口 controller：集中处理 /docs 静态资源。 */
export function createDocsController() {
  return async (pathname: string): Promise<DocsResult | null> => serveSwagger(pathname)
}
