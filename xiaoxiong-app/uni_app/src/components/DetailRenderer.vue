<template>
  <DetailCard
    :title="meta.title(detail)"
    :close-label="detail.selectedIndex != null ? t('detail.back') : t('detail.close')"
    @close="$emit('close')"
  >
    <!-- 所有 kind 的 items 都是同一个 DetailItem 形状，因此一个渲染器通吃；
         新增内容类型只加 registry 表项（标题/操作栏），这里一行都不用改。 -->
    <DetailItems :detail="detail" @select="onSelect" />

    <template #actions>
      <view v-if="actions.length" class="detail-action-row">
        <view
          v-for="a in actions"
          :key="a.key"
          class="detail-action"
          :class="{ 'detail-action--disabled': a.disabled }"
          @tap="runAction(a)"
        >
          <text class="detail-action-label">{{ a.label }}</text>
        </view>
      </view>
      <text v-if="hint" class="detail-hint">{{ hint }}</text>
    </template>
  </DetailCard>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import type { MediaDetail } from '@/core/transport/types'
import type { ShareAction } from '@/core/share/actions'
import { t } from '@/core/i18n'
import DetailCard from '@/components/DetailCard.vue'
import DetailItems from '@/features/detail/DetailItems.vue'
import { resolveDetailMeta } from '@/features/detail/registry'

/**
 * 薄分派层：按 kind 查 registry 取标题/操作栏并选内容组件。
 * 自身不含业务逻辑；详情内容只展示、不朗读、不进 TTS。
 */
const props = defineProps<{ detail: MediaDetail }>()
const emit = defineEmits<{ select: [index: number]; close: [] }>()

const meta = computed(() => resolveDetailMeta(props.detail.kind))
const actions = computed<ShareAction[]>(() => meta.value.actions(props.detail, notify))

const hint = ref('')
let hintTimer: ReturnType<typeof setTimeout> | null = null
/** 行内提示（不弹 toast）：复制成功 / 暂未开放 / 暂无链接 */
function notify(text: string): void {
  hint.value = text
  if (hintTimer) clearTimeout(hintTimer)
  hintTimer = setTimeout(() => (hint.value = ''), 1500)
}
onUnmounted(() => {
  if (hintTimer) clearTimeout(hintTimer)
})

function runAction(a: ShareAction): void {
  void a.run()
}
function onSelect(index: number): void {
  emit('select', index)
}
</script>

<style scoped>
.detail-action-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.detail-action {
  padding: 6px 12px;
  border-radius: 8px;
  background: rgba(108, 140, 255, 0.14);
}

.detail-action:active {
  background: rgba(108, 140, 255, 0.26);
}

.detail-action--disabled {
  opacity: 0.5;
}

.detail-action-label {
  font-size: 12px;
  color: #cfd8ff;
}

.detail-hint {
  font-size: 11px;
  color: #8b91ab;
}

</style>
