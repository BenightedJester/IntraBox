<script setup lang="ts">
import { computed } from 'vue'
import { useLanStore } from '../stores/lan'
import { formatChatTime } from '../utils/format'
import { historyEntryUrl } from '../utils/viewerSource'
import { extOf, type HistoryEntry } from '../shared/lan-types'

const props = defineProps<{
  modelValue: boolean
  viewer: 'model' | 'tiles'
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'open', entry: HistoryEntry): void
}>()

const store = useLanStore()

const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v),
})

const list = computed(() => store.state.history[props.viewer])

const KIND_META: Record<HistoryEntry['kind'], { label: string; icon: string; color: string }> = {
  local: { label: '本地', icon: 'FolderOpened', color: 'var(--ib-violet)' },
  lan: { label: '局域网', icon: 'Connection', color: 'var(--ib-cyan)' },
  url: { label: 'URL', icon: 'Link', color: 'var(--ib-amber)' },
}

function kindMeta(entry: HistoryEntry) {
  return KIND_META[entry.kind]
}

function openEntry(entry: HistoryEntry) {
  emit('open', entry)
  open.value = false
}

function removeEntry(entry: HistoryEntry) {
  void store.removeHistory(props.viewer, entry.id)
}

function clearAll() {
  void store.clearHistory(props.viewer)
}

function entryUrl(entry: HistoryEntry): string {
  return historyEntryUrl(entry)
}

function formatTime(ts: number): string {
  return formatChatTime(ts)
}
</script>

<template>
  <el-drawer v-model="open" direction="rtl" size="400px" class="ib-dark history-drawer" :with-header="false">
    <div class="history">
      <header class="history__head">
        <div class="history__title">
          <el-icon :size="18"><Clock /></el-icon>
          <span>打开历史</span>
          <em v-if="list.length">{{ list.length }}</em>
        </div>
        <el-popconfirm
          v-if="list.length"
          title="清空全部历史记录？"
          confirm-button-text="清空"
          cancel-button-text="取消"
          width="220"
          popper-class="ib-dark"
          @confirm="clearAll"
        >
          <template #reference>
            <el-button size="small" text type="danger" :icon="'Delete'">清空</el-button>
          </template>
        </el-popconfirm>
      </header>

      <div v-if="list.length === 0" class="history__empty">
        <el-icon :size="40"><Clock /></el-icon>
        <p>还没有打开记录</p>
        <span>打开过的模型 / 瓦片会出现在这里，点击即可再次打开</span>
      </div>

      <div v-else class="history__list">
        <button
          v-for="entry in list"
          :key="entry.id"
          class="history-item"
          :title="entryUrl(entry)"
          @click="openEntry(entry)"
        >
          <span class="history-item__icon" :style="{ color: kindMeta(entry).color, borderColor: kindMeta(entry).color }">
            <el-icon :size="16"><component :is="kindMeta(entry).icon" /></el-icon>
          </span>
          <span class="history-item__main">
            <span class="history-item__name">
              {{ entry.name }}
              <i class="history-item__ext">{{ extOf(entry.name).toUpperCase() }}</i>
            </span>
            <span class="history-item__origin">{{ entry.originLabel }}</span>
            <span class="history-item__meta">
              <i :style="{ color: kindMeta(entry).color }">{{ kindMeta(entry).label }}</i>
              {{ formatTime(entry.ts) }}
            </span>
          </span>
          <span class="history-item__del" title="删除这条记录" @click.stop="removeEntry(entry)">
            <el-icon :size="14"><Close /></el-icon>
          </span>
        </button>
      </div>
    </div>
  </el-drawer>
</template>

<style scoped>
.history {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.history__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 18px 12px;
  border-bottom: 1px solid var(--ib-space-border);
}
.history__title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 700;
  color: var(--ib-space-ink);
}
.history__title .el-icon {
  color: var(--ib-indigo);
}
.history__title em {
  font-style: normal;
  font-size: 11px;
  font-weight: 600;
  color: var(--ib-space-ink-2);
  background: rgba(122, 144, 210, 0.14);
  border-radius: 10px;
  padding: 1px 8px;
}

.history__empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--ib-space-ink-3);
  text-align: center;
  padding: 24px;
}
.history__empty p {
  margin: 6px 0 0;
  font-size: 14px;
  color: var(--ib-space-ink-2);
}
.history__empty span {
  font-size: 12px;
  max-width: 240px;
}

.history__list {
  flex: 1;
  overflow-y: auto;
  padding: 10px 12px 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.history-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  background: rgba(122, 144, 210, 0.06);
  border-radius: 11px;
  padding: 10px 12px;
  cursor: pointer;
  font-family: inherit;
  color: var(--ib-space-ink);
  transition: background 0.15s, border-color 0.15s;
}
.history-item:hover {
  background: rgba(122, 144, 210, 0.14);
  border-color: var(--ib-space-border);
}
.history-item__icon {
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  border: 1px solid;
  background: rgba(12, 17, 32, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
}
.history-item__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.history-item__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--ib-space-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.history-item__ext {
  font-style: normal;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: var(--ib-space-ink-3);
  border: 1px solid var(--ib-space-border);
  border-radius: 4px;
  padding: 0 4px;
  margin-left: 5px;
  vertical-align: 1px;
}
.history-item__origin {
  font-size: 11.5px;
  color: var(--ib-space-ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.history-item__meta {
  font-size: 11px;
  color: var(--ib-space-ink-3);
}
.history-item__meta i {
  font-style: normal;
  font-weight: 600;
  margin-right: 6px;
}
.history-item__del {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ib-space-ink-3);
  opacity: 0;
  transition: opacity 0.15s, background 0.15s, color 0.15s;
}
.history-item:hover .history-item__del {
  opacity: 1;
}
.history-item__del:hover {
  background: rgba(244, 81, 124, 0.16);
  color: var(--ib-rose);
}
</style>

<style>
.history-drawer.el-drawer {
  background: var(--ib-space-1);
  border-left: 1px solid var(--ib-space-border);
}
.history-drawer .el-drawer__body {
  padding: 0;
  overflow: hidden;
}
</style>