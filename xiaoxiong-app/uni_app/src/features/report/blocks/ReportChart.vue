<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { t } from '@/core/i18n'
import { appConfig } from '@/core/config'
import { resolveImageUrl } from '@/core/text/imageUrl'
import { copyText } from '@/core/share/clipboard'
import { downloadAndSaveImage } from '@/core/share/saveImage'
import type { ReportBlock } from '@/core/transport/types'
import { chartTypesFor, type ChartType } from '../chartModel'
import { buildChartActions, type ReportAction } from '../reportActions'
import ReportToolbar from '../ReportToolbar.vue'
import ReportFullscreen from '../ReportFullscreen.vue'
import ChartRenderer from './ChartRenderer.vue'

/**
 * 图表块：只负责业务状态（视图类型/展开）与操作回调，工具栏/全屏都是通用组件。
 * 工具栏由 ReportAction 数组驱动（buildChartActions），ReportToolbar 只按数组渲染，
 * 不认识具体业务；绘制交给 ChartRenderer。与商品详情体系完全独立。
 */
type ChartBlock = Extract<ReportBlock, { type: 'chart' }>
const props = defineProps<{ block: ChartBlock }>()

/** 标题与关闭由外层 ReportPanel 提供，让标题/按钮/关闭在同一行。 */
const reportTitle = inject<() => string>('reportTitle', () => t('report.title'))
const reportClose = inject<() => void>('reportClose', () => {})

/** 可用图表类型严格按后端 chart.type（PC 端规则）；无可用图表时显示明细表。 */
const availableTypes = computed<ChartType[]>(() =>
  chartTypesFor(props.block.columns, props.block.rows, props.block.chartType),
)
const viewType = ref<ChartType | 'table'>(availableTypes.value.length ? 'column' : 'table')
const openKey = ref<string | null>(null)
const fullOpenKey = ref<string | null>(null)
const expanded = ref(false)

const typeOptions = computed(() => [
  { key: 'column' as const, label: t('report.chartColumn'), glyph: '▥' },
  { key: 'bar' as const, label: t('report.chartBar'), glyph: '▤' },
  { key: 'line' as const, label: t('report.chartLine'), glyph: '╱' },
])

function chooseView(v: string): void {
  viewType.value = v as ChartType | 'table'
  openKey.value = null
}

/** 后端 PNG 绝对地址（有数据时挂在 chart.imageUrl，供下载/复制）。 */
const imageUrl = computed(() => resolveImageUrl(props.block.imageUrl ?? '', appConfig.voice.builtin.url))
const notice = ref('')
function flash(msg: string): void {
  notice.value = msg
  // 停留 3 秒：真机上 2 秒一闪而过，用户来不及看清成功/失败（「点击没反应」的体感来源之一）
  setTimeout(() => { if (notice.value === msg) notice.value = '' }, 3000)
}

async function copyLink(): Promise<void> {
  if (!imageUrl.value) return
  const ok = await copyText(imageUrl.value)
  flash(ok ? t('report.copied') : t('report.downloadFailed'))
}

/** 失败环节 → 可读原因（走 i18n）+ errMsg 摘要（技术细节，便于真机截图定位根因）。 */
function failReason(r: Awaited<ReturnType<typeof downloadAndSaveImage>>): string {
  const reasonMap: Record<string, string> = {
    download: t('report.failNetwork'),
    status: t('report.failStatus'),
    album: t('report.failAlbum'),
    timeout: t('report.failTimeout'),
    empty: t('report.failEmpty'),
  }
  const reason = reasonMap[r.stage ?? ''] ?? t('report.downloadFailed')
  // errMsg 截前 40 字符（如 "saveImageToPhotosAlbum:fail auth deny"），附在原因后
  const detail = r.errMsg ? ` (${r.errMsg.slice(0, 40)})` : ''
  return t('report.failReason', { reason, detail })
}

async function downloadImage(): Promise<void> {
  if (!imageUrl.value) return
  flash(t('report.downloading'))
  const r = await downloadAndSaveImage(imageUrl.value)
  flash(r.ok ? t('report.downloadStarted') : failReason(r))
}

/** 通用操作数组：业务状态 → 数据，ReportToolbar 只管渲染。 */
const actions = computed<ReportAction[]>(() =>
  buildChartActions({
    chartTypes: availableTypes.value.length ? typeOptions.value : [],
    currentView: viewType.value,
    hasImage: !!imageUrl.value,
    labels: {
      detailTable: t('report.detailTable'),
      maximize: t('report.maximize'),
      close: t('report.close'),
      downloadImage: t('report.downloadImage'),
      copyImageLink: t('report.copyImageLink'),
    },
    onSelectView: chooseView,
    onMaximize: () => { expanded.value = true },
    onClose: reportClose,
    onDownload: downloadImage,
    onCopyLink: copyLink,
  }),
)

/** 最大化头部复用的图片操作（下载/复制），与主工具栏共用回调，但用自己的下拉展开态。 */
const imageActions = computed<ReportAction[]>(() => actions.value.filter((a) => a.key === 'image-actions'))

/** 最大化面板底部的视图切换条（三种图 + 明细表），复用同一套 label。 */
const viewTabs = computed(() => [
  ...typeOptions.value.map((o) => ({ key: o.key, label: o.label })),
  { key: 'table', label: t('report.detailTable') },
])
</script>

<template>
  <view class="report-chart">
    <!-- 通用工具栏：标题 + 操作数组 + 关闭，全在同一行 -->
    <ReportToolbar
      :title="reportTitle()"
      :actions="actions"
      :open-key="openKey"
      @update:open-key="openKey = $event"
    />

    <!-- 行内提示（不用 Toast） -->
    <text v-if="notice" class="chart-notice">{{ notice }}</text>

    <!-- 正常视图 -->
    <view class="chart-body">
      <ChartRenderer :block="block" :view-type="viewType" canvas-id="report-line" />
    </view>

    <!-- 通用全屏容器：内容复用同一绘制组件，底部放视图切换条 -->
    <ReportFullscreen :visible="expanded" :title="reportTitle()" @close="expanded = false">
      <ChartRenderer
        :block="block"
        :view-type="viewType"
        canvas-id="report-line-full"
        :expanded="true"
      />
      <template #tools>
        <ReportToolbar
          title=""
          :show-title="false"
          :actions="imageActions"
          :open-key="fullOpenKey"
          @update:open-key="fullOpenKey = $event"
        />
      </template>
      <template #footer>
        <view class="view-tabs">
          <view
            v-for="tab in viewTabs"
            :key="tab.key"
            class="view-tab"
            :class="{ active: viewType === tab.key }"
            @tap="chooseView(tab.key)"
          >
            <text>{{ tab.label }}</text>
          </view>
        </view>
      </template>
    </ReportFullscreen>
  </view>
</template>

<style scoped>
.report-chart { width: 100%; }
.chart-notice { display: block; font-size: 11px; color: #9be8cd; margin-bottom: 6px; }
.chart-body { width: 100%; }
.view-tabs { display: flex; flex-direction: row; gap: 10px; flex-wrap: wrap; }
.view-tab { padding: 6px 12px; border-radius: 8px; background: rgba(255, 255, 255, 0.06); }
.view-tab.active { background: rgba(79, 140, 255, 0.2); }
.view-tab text { font-size: 12px; color: #e8eaf6; }
</style>
