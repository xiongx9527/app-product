import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  // 与 vite.config.ts 对齐，保证测试里 `@/` 别名能解析（导入用别名的模块时不会报错）
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // 允许测试跨包导入网关源码（cross-compat 测试验证前后端信封格式一致）
  server: {
    fs: {
      allow: [fileURLToPath(new URL('../..', import.meta.url))],
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
