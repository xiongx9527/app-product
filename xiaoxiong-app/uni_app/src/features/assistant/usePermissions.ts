import { computed, onUnmounted, ref, watch, type Ref } from 'vue'
import {
  readAppPermissions,
  type AppPermissions,
  type PermissionState,
} from '@/core/permission/permissionStatus'
import { hasMicBeenGranted, micGranted } from '@/core/audio/micEvidence'
import type { HealthStatus } from './useHealth'

/** 与 health-item 同形的界面项；key 对应 i18n 的 health.mic / health.location */
export interface PermissionItem {
  key: 'mic' | 'location'
  status: HealthStatus
  state: PermissionState
}

/** 三色映射：已授权=绿(ok)、明确拒绝=红(down)、未申请/平台查不到=黄(warn，不误报故障) */
export function toPermissionItems(p: AppPermissions): PermissionItem[] {
  const statusOf = (s: PermissionState): HealthStatus =>
    s === 'granted' ? 'ok' : s === 'denied' ? 'down' : 'warn'
  return [
    { key: 'mic', status: statusOf(p.mic), state: p.mic },
    { key: 'location', status: statusOf(p.location), state: p.location },
  ]
}

/** 与能力健康度同频：连上轮询一次，之后定时刷新（用户可能在系统设置里改权限）。 */
const POLL_MS = 30000

/**
 * 权限状态：连上 WS 后只读检测一次、之后定时刷新，断开即清空为 unknown。
 * 全程只读查询，不申请授权、不弹框——定位授权仍只由网关「位置/天气」需求懒加载触发。
 */
export function usePermissions(wsConnected: Ref<boolean>) {
  const permissions = ref<AppPermissions>({ mic: 'unknown', location: 'unknown' })
  const permissionItems = computed(() => toPermissionItems(permissions.value))
  let timer: ReturnType<typeof setInterval> | null = null

  function stopTimer(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  async function refreshPermissions(): Promise<void> {
    // 能唤醒（getUserMedia 成功过）就是麦克风已授权的铁证，覆盖权限 API 在
    // H5/部分机型的 unknown 或 config error 误报，避免「明明能说话却显示黄点」。
    permissions.value = await readAppPermissions({ micGranted: hasMicBeenGranted() })
  }

  function start(): void {
    if (timer) return
    void refreshPermissions()
    timer = setInterval(() => void refreshPermissions(), POLL_MS)
  }

  function reset(): void {
    stopTimer()
    permissions.value = { mic: 'unknown', location: 'unknown' }
  }

  watch(
    wsConnected,
    (connected) => {
      if (connected) start()
      else reset()
    },
    { immediate: true },
  )

  // 录音一成功（能唤醒）就立刻重算麦克风状态，不等下一次 30s 轮询：
  // 否则用户明明能说话，胶囊还黄着，看起来像故障。
  watch(micGranted, (granted) => {
    if (granted && wsConnected.value) void refreshPermissions()
  })

  onUnmounted(stopTimer)

  return { permissions, permissionItems, refreshPermissions }
}
