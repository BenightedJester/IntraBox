<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { useLanStore } from '../stores/lan'
import { formatBytes, formatMtime, extOf, copyText } from '../utils/format'
import { isModelFile, isTilesetFile, type FileEntry, type PeerInfo, type PublicShare } from '../shared/lan-types'

/**
 * 局域网文件浏览器：设备（本机 + 邻居）-> 共享 -> 目录 三级导航。
 * filter 控制哪些文件可被“打开”（model / tiles / any）。
 */
const props = withDefaults(
  defineProps<{
    filter?: 'model' | 'tiles' | 'any'
    initialPeerId?: string
  }>(),
  { filter: 'any', initialPeerId: '' },
)

const emit = defineEmits<{
  (e: 'open-file', payload: { peerId: string; shareId: string; shareName: string; relPath: string; name: string }): void
}>()

const store = useLanStore()
const { state } = store

const selectedPeerId = ref(props.initialPeerId || '')
const shares = ref<PublicShare[]>([])
const selectedShareId = ref('')
const pathStack = ref<string[]>([]) // 相对路径段
const entries = ref<FileEntry[]>([])
const truncated = ref(false)
const loading = ref(false)
const error = ref('')
const filterText = ref('')
const sortKey = ref<'name' | 'size' | 'mtime'>('name')
const sortAsc = ref(true)

const currentPath = computed(() => pathStack.value.join('/'))
/** 本机作为首个设备：自己的共享无需等待邻居发现即可浏览 */
const selfPeer = computed<PeerInfo>(() => ({
  id: state.self.id,
  name: state.self.name || '本机',
  ip: '127.0.0.1',
  port: state.self.port,
  lastSeen: 0,
}))
const devices = computed(() => [selfPeer.value, ...state.peers])
const selectedPeer = computed(() => devices.value.find((p) => p.id === selectedPeerId.value))
const selectedShare = computed(() => shares.value.find((s) => s.id === selectedShareId.value))

const filteredEntries = computed(() => {
  let list = entries.value
  const kw = filterText.value.trim().toLowerCase()
  if (kw) list = list.filter((e) => e.name.toLowerCase().includes(kw))
  const dir = sortAsc.value ? 1 : -1
  return [...list].sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1
    if (sortKey.value === 'size') return (a.size - b.size) * dir
    if (sortKey.value === 'mtime') return (a.mtime - b.mtime) * dir
    return a.name.localeCompare(b.name, 'zh-CN') * dir
  })
})

function canOpen(entry: FileEntry): boolean {
  if (entry.dir) return false
  if (props.filter === 'model') return isModelFile(entry.name)
  if (props.filter === 'tiles') return isTilesetFile(entry.name)
  return true
}

async function loadShares() {
  if (!selectedPeerId.value) return
  loading.value = true
  error.value = ''
  shares.value = []
  selectedShareId.value = ''
  entries.value = []
  pathStack.value = []
  try {
    shares.value = await window.api.peer.shares(selectedPeerId.value)
    if (shares.value.length > 0) {
      selectedShareId.value = shares.value[0].id
      await loadDir()
    }
  } catch (err) {
    error.value = String(err)
  } finally {
    loading.value = false
  }
}

async function loadDir() {
  if (!selectedPeerId.value || !selectedShareId.value) return
  loading.value = true
  error.value = ''
  try {
    const listing = await window.api.peer.list(selectedPeerId.value, selectedShareId.value, currentPath.value)
    entries.value = listing.entries
    truncated.value = listing.truncated
  } catch (err) {
    error.value = String(err)
    entries.value = []
  } finally {
    loading.value = false
  }
}

function selectPeer(id: string) {
  if (selectedPeerId.value === id) return
  selectedPeerId.value = id
  void loadShares()
}

function selectShare(id: string) {
  if (selectedShareId.value === id) return
  selectedShareId.value = id
  pathStack.value = []
  void loadDir()
}

function enterDir(entry: FileEntry) {
  if (!entry.dir) return
  pathStack.value = [...pathStack.value, entry.name]
  filterText.value = ''
  void loadDir()
}

function jumpTo(index: number) {
  pathStack.value = pathStack.value.slice(0, index)
  void loadDir()
}

function relPathOf(entry: FileEntry): string {
  return [...pathStack.value, entry.name].join('/')
}

function onRowDblClick(entry: FileEntry) {
  if (entry.dir) enterDir(entry)
  else if (canOpen(entry)) openFile(entry)
}

function rowClassName({ row }: { row: FileEntry }): string {
  return canOpen(row) ? 'row-openable' : ''
}

function openFile(entry: FileEntry) {
  if (!selectedPeer.value || !selectedShare.value) return
  emit('open-file', {
    peerId: selectedPeerId.value,
    shareId: selectedShareId.value,
    shareName: selectedShare.value.name,
    relPath: relPathOf(entry),
    name: entry.name,
  })
}

async function downloadFile(entry: FileEntry) {
  if (!selectedPeer.value || !selectedShare.value) return
  const url = `http://${selectedPeer.value.ip}:${selectedPeer.value.port}/share/${selectedShareId.value}/fs/${relPathOf(entry)
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`
  await store.startDownload(url, entry.name, true)
}

async function copyLink(entry: FileEntry) {
  if (!selectedPeer.value) return
  const url = `http://${selectedPeer.value.ip}:${selectedPeer.value.port}/share/${selectedShareId.value}/fs/${relPathOf(entry)
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`
  if (await copyText(url)) ElMessage.success('直链已复制')
  else ElMessage.error('复制失败')
}

function toggleSort(key: 'name' | 'size' | 'mtime') {
  if (sortKey.value === key) sortAsc.value = !sortAsc.value
  else {
    sortKey.value = key
    sortAsc.value = true
  }
}

function fileIcon(entry: FileEntry): string {
  if (entry.dir) return 'Folder'
  const ext = extOf(entry.name)
  if (isModelFile(entry.name)) return 'Box'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ktx2'].includes(ext)) return 'Picture'
  if (['mp4', 'mov', 'avi', 'mkv'].includes(ext)) return 'VideoCamera'
  if (['mp3', 'wav', 'flac'].includes(ext)) return 'Headset'
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'Files'
  if (ext === 'json') return 'Tickets'
  return 'Document'
}

watch(
  () => devices.value.map((p) => p.id).join(','),
  () => {
    // 选中的设备离线后清空
    if (selectedPeerId.value && !devices.value.some((p) => p.id === selectedPeerId.value)) {
      selectedPeerId.value = ''
      shares.value = []
      entries.value = []
    }
    // 设备后于对话框上线时补自动选择，避免列表可见却永远空载
    if (!selectedPeerId.value && devices.value.length > 0) {
      selectedPeerId.value = devices.value[0].id
      void loadShares()
    }
  },
)

onMounted(() => {
  if (!selectedPeerId.value && devices.value.length > 0) {
    selectedPeerId.value = devices.value[0].id
  }
  if (selectedPeerId.value) void loadShares()
})

defineExpose({ refresh: loadShares })
</script>

<template>
  <div class="lan-browser">
    <!-- 设备选择（本机 + 邻居） -->
    <div class="lan-browser__peers">
      <div class="lan-browser__label">设备</div>
      <button
        v-for="peer in devices"
        :key="peer.id"
        class="peer-chip"
        :class="{ 'peer-chip--active': peer.id === selectedPeerId }"
        @click="selectPeer(peer.id)"
      >
        <span class="ib-online-dot" />
        <span class="peer-chip__name">{{ peer.name }}</span>
        <span v-if="peer.id === state.self.id" class="peer-chip__self">本机</span>
        <span v-else class="peer-chip__ip">{{ peer.ip }}</span>
      </button>
      <el-empty v-if="state.peers.length === 0" description="暂无其它在线邻居" :image-size="48" />
    </div>

    <!-- 共享 + 目录 -->
    <div class="lan-browser__main">
      <div v-if="!selectedPeerId" class="lan-browser__placeholder">
        <el-empty description="选择左侧设备以浏览其共享" :image-size="72" />
      </div>
      <template v-else>
        <div class="lan-browser__toolbar">
          <el-select
            :model-value="selectedShareId"
            placeholder="选择共享"
            size="default"
            style="width: 200px"
            :disabled="shares.length === 0"
            @change="selectShare"
          >
            <el-option v-for="s in shares" :key="s.id" :label="s.name" :value="s.id" />
          </el-select>

          <div class="breadcrumbs">
            <button class="breadcrumbs__item" @click="jumpTo(0)">
              <el-icon><HomeFilled /></el-icon>
              {{ selectedShare?.name || '根目录' }}
            </button>
            <template v-for="(seg, i) in pathStack" :key="i">
              <span class="breadcrumbs__sep">/</span>
              <button class="breadcrumbs__item" @click="jumpTo(i + 1)">{{ seg }}</button>
            </template>
          </div>

          <el-input
            v-model="filterText"
            placeholder="过滤当前目录…"
            size="default"
            clearable
            style="width: 180px"
            :prefix-icon="'Search'"
          />
          <el-button :icon="'Refresh'" circle @click="loadDir" />
        </div>

        <div v-loading="loading" class="lan-browser__table">
          <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="lan-browser__error" />
          <el-table
            v-else
            :data="filteredEntries"
            height="100%"
            size="default"
            :row-class-name="rowClassName"
            @row-dblclick="onRowDblClick"
          >
            <el-table-column label="名称" min-width="260">
              <template #header>
                <button class="sort-btn" @click="toggleSort('name')">
                  名称 <el-icon v-if="sortKey === 'name'"><component :is="sortAsc ? 'Top' : 'Bottom'" /></el-icon>
                </button>
              </template>
              <template #default="{ row }">
                <div class="file-name" :class="{ 'file-name--dim': !row.dir && !canOpen(row) && filter !== 'any' }">
                  <el-icon :size="17" class="file-name__icon">
                    <component :is="fileIcon(row)" />
                  </el-icon>
                  <span>{{ row.name }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="大小" width="110" align="right">
              <template #header>
                <button class="sort-btn" @click="toggleSort('size')">
                  大小 <el-icon v-if="sortKey === 'size'"><component :is="sortAsc ? 'Top' : 'Bottom'" /></el-icon>
                </button>
              </template>
              <template #default="{ row }">
                <span class="cell-muted">{{ row.dir ? '—' : formatBytes(row.size) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="修改时间" width="160">
              <template #header>
                <button class="sort-btn" @click="toggleSort('mtime')">
                  修改时间 <el-icon v-if="sortKey === 'mtime'"><component :is="sortAsc ? 'Top' : 'Bottom'" /></el-icon>
                </button>
              </template>
              <template #default="{ row }">
                <span class="cell-muted">{{ formatMtime(row.mtime) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="200" align="right">
              <template #default="{ row }">
                <el-button v-if="row.dir" link type="primary" size="small" @click="enterDir(row)">打开</el-button>
                <template v-else>
                  <el-button v-if="canOpen(row)" link type="primary" size="small" @click="openFile(row)">
                    {{ filter === 'any' ? '打开' : '查看' }}
                  </el-button>
                  <el-button link size="small" @click="downloadFile(row)">下载</el-button>
                  <el-button link size="small" @click="copyLink(row)">复制链接</el-button>
                </template>
              </template>
            </el-table-column>
            <template #empty>
              <el-empty :description="filterText ? '没有匹配的文件' : '空目录'" :image-size="60" />
            </template>
          </el-table>
          <div v-if="truncated" class="lan-browser__truncated">目录内容过多，仅显示前 5000 项</div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.lan-browser {
  display: flex;
  gap: 14px;
  height: 100%;
  min-height: 320px;
}

.lan-browser__peers {
  width: 190px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  padding-right: 4px;
}

.lan-browser__label {
  font-size: 12px;
  font-weight: 600;
  color: var(--ib-ink-3);
  letter-spacing: 1px;
  padding: 2px 4px 6px;
}

.peer-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-radius: 10px;
  border: 1px solid var(--ib-border);
  background: var(--ib-surface);
  cursor: pointer;
  text-align: left;
  transition: all 0.16s;
  font-family: inherit;
}
.peer-chip:hover {
  border-color: var(--ib-indigo);
  transform: translateX(2px);
}
.peer-chip--active {
  background: linear-gradient(120deg, #eef1ff, #f5f0ff);
  border-color: var(--ib-indigo);
}
.peer-chip__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--ib-ink);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.peer-chip__ip {
  font-size: 11px;
  color: var(--ib-ink-3);
}
.peer-chip__self {
  flex-shrink: 0;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--ib-indigo);
  border: 1px solid var(--ib-indigo);
  border-radius: 6px;
  padding: 0 5px;
}

.lan-browser__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.lan-browser__placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.lan-browser__toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.breadcrumbs {
  flex: 1;
  min-width: 120px;
  display: flex;
  align-items: center;
  gap: 2px;
  overflow-x: auto;
  white-space: nowrap;
  font-size: 13px;
}
.breadcrumbs__item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: none;
  color: var(--ib-indigo);
  cursor: pointer;
  font-size: 13px;
  padding: 3px 5px;
  border-radius: 6px;
  font-family: inherit;
}
.breadcrumbs__item:hover {
  background: #eef1ff;
}
.breadcrumbs__sep {
  color: var(--ib-ink-3);
}

.lan-browser__table {
  flex: 1;
  min-height: 0;
  position: relative;
  border: 1px solid var(--ib-border);
  border-radius: 12px;
  overflow: hidden;
  background: var(--ib-surface);
}
.lan-browser__error {
  margin: 12px;
}
.lan-browser__truncated {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  text-align: center;
  font-size: 12px;
  color: var(--ib-warning);
  background: #fff8ec;
  padding: 4px;
}

.file-name {
  display: flex;
  align-items: center;
  gap: 8px;
}
.file-name__icon {
  color: var(--ib-indigo);
}
.file-name--dim {
  opacity: 0.45;
}
.cell-muted {
  color: var(--ib-ink-2);
  font-size: 12.5px;
}
.sort-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: none;
  background: none;
  cursor: pointer;
  font-weight: 600;
  color: inherit;
  font-size: 13px;
  font-family: inherit;
  padding: 0;
}
.sort-btn:hover {
  color: var(--ib-indigo);
}

:deep(.row-openable) {
  cursor: pointer;
}
</style>