<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ReportAction, ReportActionChild } from './reportActions'

/**
 * 通用报表工具栏：标题在左，操作项数组在右；只按 ReportAction 渲染，
 * 不认识任何业务词（图表/明细/下载/复制都由数组数据描述，见 detail/actions.ts 范式）。
 * - 同 group 的相邻项渲染进同一个 segmented 框；
 * - kind=select 渲染「当前项 + ▾」和下拉列表（当前项高亮 ✓）；
 * - kind=close 渲染图标按钮（icon 优先于 glyph）。
 */
const props = withDefaults(
  defineProps<{
    title: string
    actions: ReportAction[]
    /** 展开中的 select key（由父组件持有，便于切换视图后收起） */
    openKey?: string | null
    /** 是否显示标题（最大化头部工具位复用时隐藏） */
    showTitle?: boolean
  }>(),
  { openKey: null, showTitle: true },
)

const emit = defineEmits<{
  action: [action: ReportAction]
  'select-child': [action: ReportAction, child: ReportActionChild]
  'update:openKey': [key: string | null]
}>()

/** 按 group 把相邻同组项聚合成组；无 group 的项各自成组。 */
interface ActionGroup { key: string; items: ReportAction[] }
const groups = computed<ActionGroup[]>(() => {
  const out: ActionGroup[] = []
  props.actions.forEach((a, i) => {
    if (a.group && out.length && out[out.length - 1].key === a.group) {
      out[out.length - 1].items.push(a)
    } else {
      out.push({ key: a.group ?? `solo-${i}`, items: [a] })
    }
  })
  return out
})

function toggleSelect(a: ReportAction): void {
  emit('update:openKey', props.openKey === a.key ? null : a.key)
  a.run?.()
}

function chooseChild(a: ReportAction, child: ReportActionChild): void {
  emit('select-child', a, child)
  child.run?.()
}

function tap(a: ReportAction): void {
  emit('action', a)
  a.run?.()
}
</script>

<template>
  <view class="report-toolbar">
    <text v-if="showTitle" class="toolbar-title">{{ title }}</text>
    <view class="toolbar-actions">
      <view v-for="grp in groups" :key="grp.key" class="action-group" :class="{ segmented: grp.items.length > 1 }">
        <view
          v-for="a in grp.items"
          :key="a.key"
          class="tool-btn"
          :class="{ active: a.active, 'tool-close': a.kind === 'close' }"
          :aria-label="a.label"
          @tap="a.kind === 'select' ? toggleSelect(a) : tap(a)"
        >
          <!-- 下拉：当前项图标 + ▾ -->
          <template v-if="a.kind === 'select'">
            <text class="tool-glyph">{{ a.glyph || '▥' }}</text>
            <text class="tool-caret">▾</text>
            <view v-if="openKey === a.key && a.children?.length" class="action-menu">
              <view
                v-for="child in a.children"
                :key="child.key"
                class="action-menu-item"
                :class="{ active: child.active }"
                @tap.stop="chooseChild(a, child)"
              >
                <text class="menu-glyph">{{ child.glyph || '·' }}</text>
                <text class="menu-label">{{ child.label }}</text>
                <text v-if="child.active" class="menu-check">✓</text>
              </view>
            </view>
          </template>
          <!-- 普通按钮：icon 优先 -->
          <image v-else-if="a.icon" class="close-icon" :src="a.icon" mode="aspectFit" />
          <text v-else class="tool-glyph">{{ a.glyph || '·' }}</text>
        </view>
      </view>
    </view>
  </view>
</template>

<style scoped>
.report-toolbar {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.toolbar-title {
  font-size: 12px;
  font-weight: 600;
  color: #9be8cd;
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.toolbar-actions {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.action-group {
  display: flex;
  flex-direction: row;
  align-items: center;
}
.action-group.segmented {
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 8px;
  overflow: visible;
}
.action-group.segmented .tool-btn + .tool-btn {
  border-left: 1px solid rgba(255, 255, 255, 0.14);
}
.tool-btn {
  position: relative;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 3px;
  min-width: 28px;
  height: 28px;
  padding: 0 8px;
  border-radius: 8px;
}
.action-group.segmented .tool-btn {
  border-radius: 0;
}
.tool-btn.active {
  background: rgba(79, 140, 255, 0.2);
}
.tool-glyph {
  font-size: 14px;
  color: #b9bed6;
}
.tool-caret {
  font-size: 10px;
  color: #b9bed6;
}
.close-icon {
  width: 14px;
  height: 14px;
}
.action-menu {
  position: absolute;
  right: 0;
  top: 30px;
  z-index: 30;
  min-width: 110px;
  background: #20263a;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  padding: 4px;
}
.action-menu-item {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 6px;
}
.action-menu-item.active {
  background: rgba(79, 140, 255, 0.18);
}
.menu-glyph {
  font-size: 13px;
  color: #9be8cd;
  width: 16px;
}
.menu-label {
  flex: 1;
  font-size: 12px;
  color: #e8eaf6;
}
.menu-check {
  font-size: 12px;
  color: #9be8cd;
}
</style>
