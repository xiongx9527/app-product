<script setup lang="ts">
import { onLaunch } from '@dcloudio/uni-app'

onLaunch(() => {
  // 应用启动：这里只做基础初始化，音频/唤醒能力由 features/assistant 按需启动。
  console.log('[app-product] launch')
})
</script>

<style>
page {
  background: #0f1220;
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
</style>
