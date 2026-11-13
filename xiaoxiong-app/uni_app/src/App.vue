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

/* 宽屏（平板 / 横屏）：内容限宽居中成手机列，避免铺满拉伸。
   底部操作栏 .action-bar 的居中在其组件内（mcpservers.vue）处理，避免被 scoped 的 left/right 覆盖。 */
@media (min-width: 600px) {
  .page {
    max-width: 680px;
    margin-left: auto;
    margin-right: auto;
  }
}
</style>
