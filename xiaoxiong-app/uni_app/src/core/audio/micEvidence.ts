import { ref } from 'vue'

/**
 * 麦克风「已授权」的事实证据：只要采集链路成功启动过一次（H5 的 getUserMedia，
 * 或 App 原生 PCM 插件），就说明麦克风权限确实已授予，浏览器/系统会记住授权。
 *
 * 为什么要单独一个模块：权限查询 API 在 H5/部分机型会拿不到或返回 config error，
 * 而「能唤醒 = 能采集」是最可靠的实证。H5 与 App 两条采集链路都要能写这个标志，
 * 放在任一实现里都会造成 core/audio 内部循环依赖，故单独抽出一个共享的可观察量。
 */
export const micGranted = ref(false)

/** 标记麦克风已被证实可用（采集成功时调用）。 */
export function markMicGranted(): void {
  micGranted.value = true
}

/** 只读，不申请权限：麦克风是否曾被成功采集过。 */
export function hasMicBeenGranted(): boolean {
  return micGranted.value
}
