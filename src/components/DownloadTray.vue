<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useLanStore } from '../stores/lan'
import { formatBytes } from '../utils/format'

/** 全局下载托盘：悬浮右下角，跨页面显示进度 / 完成 / 失败 */
const store = useLanStore()
const { state } = store
const collapsed = ref(false)

const visible = computed(() => state.downloads.length > 0)
const activeCount = computed(() => state.downloads.filter((d) => d.state === 'active').length)

// 新任务开始自动展开；全部结束稍作停留后自动收起，避免遮挡查看器控制面板
let collapseTimer: number | null = null
watch(activeCount, (n, prev) => {
  if (collapseTimer !== null) {
    clearTimeout(collapseTimer)
    collapseTimer = null
  }
  if (n > 0) collapsed.value = false
  else if (prev > 0) collapseTimer = window.setTimeout(() => { collapsed.value = true }, 2600)
})

function percent(d: { received: number; total: number }): number {
  if (!d.total) return 0
  return Math.min(100, Math.round((d.received / d.total) * 100))
}

function statusText(d: { state: string; received: number; total: number; error?: string }): string {
  if (d.state === 'active') return d.total ? `${formatBytes(d.received)} / ${formatBytes(d.total)}` : formatBytes(d.received)
  if (d.state === 'done') return '已完成'
  if (d.state === 'canceled') return '已取消'
  return d.error || '下载失败'
}

function cancel(id: string) {
  void window.api.download.cancel(id)
}
function openFile(p: string) {
  void window.api.download.open(p)
}
function reveal(p: string) {
  void window.api.download.reveal(p)
}
</script>

<template>
  <transition name="tray">
    <div v-if="visible" class="download-tray ib-dark" :class="{ 'download-tray--collapsed': collapsed }">
      <div class="download-tray__head" @click="collapsed = !collapsed">
        <el-icon :size="15"><Download /></el-icon>
        <span class="download-tray__title">
          下载<template v-if="activeCount"> · {{ activeCount }} 进行中</template>
        </span>
        <el-icon class="download-tray__chevron" :size="14">
          <component :is="collapsed ? 'ArrowUp' : 'ArrowDown'" />
        </el-icon>
      </div>
      <div v-show="!collapsed" class="download-tray__list">
        <div v-for="d in state.downloads" :key="d.id" class="dl-item">
          <div class="dl-item__top">
            <span class="dl-item__name" :title="d.name">{{ d.name }}</span>
            <span class="dl-item__status" :class="`dl-item__status--${d.state}`">{{ statusText(d) }}</span>
          </div>
          <el-progress
            v-if="d.state === 'active'"
            :percentage="percent(d)"
            :stroke-width="5"
            :show-text="false"
            class="dl-item__bar"
          />
          <div class="dl-item__actions">
            <template v-if="d.state === 'active'">
              <el-button link size="small" @click="cancel(d.id)">取消</el-button>
            </template>
            <template v-else-if="d.state === 'done' && d.path">
              <el-button link size="small" type="primary" @click="openFile(d.path!)">打开</el-button>
              <el-button link size="small" @click="reveal(d.path!)">所在文件夹</el-button>
            </template>
          </div>
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.download-tray {
  position: fixed;
  right: 20px;
  bottom: 20px;
  width: 320px;
  max-height: 360px;
  z-index: 2000;
  background: rgba(12, 17, 32, 0.92);
  backdrop-filter: blur(14px);
  border: 1px solid var(--ib-space-border);
  border-radius: 14px;
  box-shadow: 0 12px 40px rgba(4, 8, 20, 0.5);
  overflow: hidden;
  color: var(--ib-space-ink);
}

.download-tray__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 14px;
  cursor: pointer;
  user-select: none;
  border-bottom: 1px solid var(--ib-space-border);
}
.download-tray--collapsed .download-tray__head {
  border-bottom: none;
}
.download-tray__title {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
}
.download-tray__chevron {
  color: var(--ib-space-ink-3);
}

.download-tray__list {
  max-height: 300px;
  overflow-y: auto;
  padding: 6px;
}

.dl-item {
  padding: 8px 10px;
  border-radius: 9px;
}
.dl-item:hover {
  background: rgba(122, 144, 210, 0.08);
}
.dl-item__top {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.dl-item__name {
  flex: 1;
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dl-item__status {
  font-size: 11px;
  color: var(--ib-space-ink-3);
  flex-shrink: 0;
}
.dl-item__status--done {
  color: var(--ib-green);
}
.dl-item__status--error {
  color: var(--ib-rose);
}
.dl-item__bar {
  margin: 6px 0 2px;
}
.dl-item__actions {
  display: flex;
  gap: 4px;
  margin-top: 2px;
  min-height: 18px;
}

.tray-enter-active,
.tray-leave-active {
  transition: all 0.25s cubic-bezier(0.22, 0.8, 0.3, 1);
}
.tray-enter-from,
.tray-leave-to {
  opacity: 0;
  transform: translateY(16px);
}
</style>