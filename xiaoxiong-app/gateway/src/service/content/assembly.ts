/**
 * 内容能力装配（不含任何具体 skill import）。
 *
 * 各 skill 通过导出 contentFactories 自注册实现，registry 生成脚本汇总到
 * skills/registry.generated.ts 的 CONTENT_FACTORIES。这里只做类型收口：把汇总的
 * （可能缺省）工厂补成完整契约，供 controller 注入核心。换源/换实现只改对应 skill。
 */
import { CONTENT_FACTORIES as registered } from '../skills/registry.generated'
import type {
  ContentSourceFactory, ContentResolverFactory, ContentExecutor,
  ContentExecutorDeps, ContentDashDeps,
} from './types'

const factories = registered as Partial<{
  contentSourceFactory: ContentSourceFactory
  contentResolverFactory: ContentResolverFactory
  contentExecutorFactory: (deps: ContentExecutorDeps) => ContentExecutor
  contentDashDeps: ContentDashDeps
}>

/** 按客户端 playback.source 构造内容源；未注册工厂时抛错（装配缺失是构建错误，不静默）。 */
export const contentSourceFactory: ContentSourceFactory = (kind) => {
  if (!factories.contentSourceFactory) throw new Error('[content] 未注册 contentSourceFactory（检查 skill contentFactories）')
  return factories.contentSourceFactory(kind)
}

/** 把内容源适配成系统能力层 MediaResolver。 */
export const contentResolverFactory: ContentResolverFactory = (source) => {
  if (!factories.contentResolverFactory) throw new Error('[content] 未注册 contentResolverFactory')
  return factories.contentResolverFactory(source)
}

/** 构造内容执行器。 */
export function contentExecutorFactory(deps: ContentExecutorDeps): ContentExecutor {
  if (!factories.contentExecutorFactory) throw new Error('[content] 未注册 contentExecutorFactory')
  return factories.contentExecutorFactory(deps)
}

/** dash 依赖（needsProxy 等）。 */
export const contentDashDeps: ContentDashDeps = factories.contentDashDeps ?? { needsProxy: () => false }
