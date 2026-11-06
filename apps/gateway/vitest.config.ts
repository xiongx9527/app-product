import { defineConfig } from 'vitest/config'

// node:sqlite 由源码通过 createRequire 加载，不经 Vite 静态扫描；
// 这里把 node: 内置模块在 SSR 下显式外置，避免依赖链里（如 drizzle-orm）的
// 静态 import 被误处理。
export default defineConfig({
  ssr: {
    external: [/^node:/],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
