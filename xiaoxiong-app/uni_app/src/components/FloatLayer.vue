<script setup lang="ts">
import { computed, onUnmounted } from 'vue'
import {
  FLOAT_INSET,
  registerFloatLayer,
  unregisterFloatLayer,
  type FloatCorner,
  type FloatPosition,
} from '@/core/adaptation/floatLayer'

/**
 * 通用悬浮容器：只负责「固定在某个角落 + 压在页面之上 + 显隐」，内容完全由 slot 决定，
 * 不含任何业务代码。任何业务都能复用：
 *   <FloatLayer id="xxx" :visible="..." corner="top-right"><任意内容 /></FloatLayer>
 * z-index 由 id 自动注册分配（core/adaptation/floatLayer），多个业务各占一层、互不遮挡；
 * 也可用 zIndex 手动覆盖。offsetX/offsetY 用于避开页面已有的 header / 底部控件。
 */
const props = withDefaults(
  defineProps<{
    /** 业务唯一标识，用于层级注册（同 id 重渲染不涨层级） */
    id: string
    visible?: boolean
    corner?: FloatCorner
    /** 相对角落的额外偏移（px），用于避开页面已有的 header / 底部控件 */
    offsetX?: number
    offsetY?: number
    /** 统一位置参数（优先于下面散开的 corner/offsetX/offsetY）；可由配置/业务整体传入 */
    position?: FloatPosition
    /** 手动指定层级（一般不用，交给自动注册即可） */
    zIndex?: number
  }>(),
  { visible: true, corner: 'bottom-right', offsetX: 0, offsetY: 0 },
)

const autoZ = registerFloatLayer(props.id)
onUnmounted(() => unregisterFloatLayer(props.id))

/** 位置以 position 参数为先，散开的 corner/offset 作为回退，保证两种用法都通用 */
const resolved = computed(() => ({
  corner: props.position?.corner ?? props.corner,
  offsetX: props.position?.offsetX ?? props.offsetX,
  offsetY: props.position?.offsetY ?? props.offsetY,
}))

const layerStyle = computed(() => {
  const inset = `${FLOAT_INSET}px`
  const { corner, offsetX, offsetY } = resolved.value
  // 居中锚点用 left:50% + translateX(-50%)，与业务偏移叠加，不依赖内容宽度（通用）
  const centered = corner.endsWith('center')
  const style: Record<string, string> = {
    zIndex: String(props.zIndex ?? autoZ),
    transform: `${centered ? 'translateX(-50%) ' : ''}translate(${offsetX}px, ${offsetY}px)`,
  }
  if (corner.startsWith('top')) style.top = inset
  else style.bottom = inset
  if (centered) style.left = '50%'
  else if (corner.endsWith('left')) style.left = inset
  else style.right = inset
  return style
})
</script>

<template>
  <view v-if="visible" class="float-layer" :style="layerStyle">
    <slot />
  </view>
</template>

<style scoped>
.float-layer {
  position: fixed;
}
</style>
