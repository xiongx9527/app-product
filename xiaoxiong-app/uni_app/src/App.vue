<script setup lang="ts">
import { onLaunch } from '@dcloudio/uni-app'

onLaunch(() => {
  // 应用启动基础初始化；主题由各页面根元素的 :style 响应式绑定驱动，无需在此操作 document。
  console.log('[app-product] launch')
})
</script>

<style>
/* 主题变量默认值（与 core/theme.ts 的 default 主题一致）。切换主题时由 applyTheme 改写。 */
:root {
  --accent: #6c8cff;
  --accent-2: #8a6cff;
  --accent-rgb: 108, 140, 255;
  --bg-base: #0f1220;
  --bg-glow: rgba(108, 140, 255, 0.18);
  /* 禁用 iOS 文本自动放大：iPhone 横屏视口更宽时，iOS 会按容器宽度放大正文字号，
     导致横竖屏、不同宽度页面之间字体大小不一致。固定为 100% 后只认显式字号。 */
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}

html,
body,
#app,
.page {
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}

page {
  background: var(--bg-base);
  color: #e8eaf6;
  font-family:
    -apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'PingFang SC',
    'Microsoft YaHei', sans-serif;
}

view,
text,
button {
  box-sizing: border-box;
}

/* 平板/宽屏（含 iPad 竖屏与横屏、手机横屏）一律铺满宽度，不留左右黑边或留白。
   此前竖屏曾限宽 680 居中成手机列，但用户要求 iPad 竖屏也要占满。
   底部操作栏 .action-bar 的居中在其组件内（mcpservers.vue）处理，避免被 scoped 的 left/right 覆盖。 */
</style>
