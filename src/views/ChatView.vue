<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useLanStore } from '../stores/lan'
import { formatBytes, formatChatTime, nameInitial, idHue, extOf, copyText } from '../utils/format'
import type { ChatMessage } from '../shared/lan-types'
import { sourceFromUrl } from '../utils/viewerSource'

const router = useRouter()
const store = useLanStore()
const { state } = store

const draft = computed({
  get: () => (state.activePeerId ? state.drafts[state.activePeerId] ?? '' : ''),
  set: (v: string) => {
    if (state.activePeerId) state.drafts[state.activePeerId] = v
  },
})

const activePeer = computed(() => store.peerById(state.activePeerId))
const messages = store.activeMessages
const scrollRef = ref<HTMLElement>()
const dragOver = ref(false)
const nameDialog = ref(false)
const nameInput = ref('')
const sending = ref(false)

// 自包含格式可直接从聊天文件链接预览（无需外部资源）
const SELF_CONTAINED = ['glb', 'stl', 'ply']
function canPreviewModel(msg: ChatMessage): boolean {
  return msg.type === 'file' && !!msg.file && SELF_CONTAINED.includes(extOf(msg.file.name)) && !!msg.file.url
}

function scrollToBottom(smooth = true) {
  nextTick(() => {
    const el = scrollRef.value
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  })
}

watch(
  () => messages.value.length,
  () => scrollToBottom(),
)
watch(
  () => state.activePeerId,
  () => scrollToBottom(false),
)

function selectPeer(id: string) {
  store.setActivePeer(id)
}

async function send() {
  const text = draft.value.trim()
  if (!text || !activePeer.value) return
  sending.value = true
  try {
    await store.sendText(text)
    scrollToBottom()
  } finally {
    sending.value = false
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    void send()
  }
}

async function attachFile() {
  if (!activePeer.value) return
  await store.pickAndSendFile()
  scrollToBottom()
}

async function downloadFile(msg: ChatMessage) {
  if (!msg.file?.url) return
  await store.startDownload(msg.file.url, msg.file.name, true)
}

function previewModel(msg: ChatMessage) {
  if (!msg.file?.url) return
  store.requestOpen({ viewer: 'model', source: sourceFromUrl(msg.file.url) })
  router.push('/model-viewer')
}

function retry(msg: ChatMessage) {
  void store.retryMessage(msg)
}

function revealDownload(msg: ChatMessage) {
  const d = store.downloadByUrl(msg.file?.url || '')
  if (d?.path) void window.api.download.reveal(d.path)
}

function downloadPercent(msg: ChatMessage): number {
  const d = store.downloadByUrl(msg.file?.url || '')
  return d && d.total ? Math.round((d.received / d.total) * 100) : 0
}

async function clearChat() {
  if (!activePeer.value) return
  try {
    await ElMessageBox.confirm(`清空与「${activePeer.value.name}」的聊天记录？`, '清空记录', {
      type: 'warning',
      confirmButtonText: '清空',
      cancelButtonText: '取消',
    })
    await store.clearConversation(activePeer.value.id)
  } catch {
    /* 取消 */
  }
}

function openNameDialog() {
  nameInput.value = state.self.name
  nameDialog.value = true
}

async function saveName() {
  const name = nameInput.value.trim()
  if (!name) return
  await window.api.lan.setName(name)
  nameDialog.value = false
  ElMessage.success('设备名已更新')
}

async function toggleService(on: boolean) {
  await window.api.lan.setRunning(on)
  ElMessage.success(on ? '局域网服务已启动' : '局域网服务已停止')
}

async function copyIp() {
  const ip = state.self.ips[0]
  if (ip && (await copyText(`${ip}:${state.self.port}`))) ElMessage.success('本机地址已复制')
}

// ---------------- 拖拽发送 ----------------
function onDragOver(e: DragEvent) {
  if (!activePeer.value) return
  e.preventDefault()
  dragOver.value = true
}
function onDragLeave() {
  dragOver.value = false
}
async function onDrop(e: DragEvent) {
  e.preventDefault()
  dragOver.value = false
  if (!activePeer.value) {
    ElMessage.warning('请先选择一位邻居')
    return
  }
  const files = Array.from(e.dataTransfer?.files ?? [])
  const paths = files.map((f) => window.api.getPathForFile(f)).filter(Boolean)
  if (paths.length === 0) return
  await store.sendFilePaths(paths)
  scrollToBottom()
}

function lastPreview(peerId: string): string {
  const last = store.lastMessageOf(peerId)
  if (!last) return '暂无消息'
  if (last.type === 'file') return `[文件] ${last.file?.name ?? ''}`
  return last.text ?? ''
}

onMounted(() => {
  store.chatFocused(true)
  if (!state.activePeerId && state.peers.length > 0) {
    store.setActivePeer(state.peers[0].id)
  }
  scrollToBottom(false)
})
onBeforeUnmount(() => {
  store.chatFocused(false)
})

// 供自动化测试访问
if (new URLSearchParams(location.search).has('debug')) {
  ;(window as any).__chat = { state, store }
}
</script>

<template>
  <div class="chat">
    <!-- 左侧：自身 + 邻居列表 -->
    <aside class="chat__rail">
      <div class="self-card">
        <div class="self-card__avatar" :style="{ background: `hsl(${idHue(state.self.id)} 62% 52%)` }">
          {{ nameInitial(state.self.name) }}
        </div>
        <div class="self-card__meta">
          <div class="self-card__name" :title="state.self.name">{{ state.self.name || '本机' }}</div>
          <button class="self-card__addr" @click="copyIp">
            <span :class="state.self.running ? 'ib-online-dot' : 'ib-offline-dot'" />
            {{ state.self.running ? `在线 · 端口 ${state.self.port}` : '服务已停止' }}
          </button>
        </div>
        <el-button :icon="'EditPen'" circle size="small" @click="openNameDialog" />
      </div>

      <div class="rail-service">
        <span class="rail-service__label">局域网服务</span>
        <el-switch :model-value="state.self.running" size="small" @change="toggleService(Boolean($event))" />
      </div>

      <div class="rail-label">邻居 · {{ state.peers.length }}</div>
      <div class="peer-list">
        <el-empty v-if="state.peers.length === 0" :image-size="60" description="等待邻居上线…">
          <template #description>
            <p class="peer-empty__title">暂无在线邻居</p>
            <p class="peer-empty__hint">确保设备在同一局域网，且防火墙放行本应用</p>
          </template>
        </el-empty>
        <button
          v-for="peer in state.peers"
          :key="peer.id"
          class="peer-item"
          :class="{ 'peer-item--active': peer.id === state.activePeerId }"
          @click="selectPeer(peer.id)"
        >
          <div class="peer-item__avatar" :style="{ background: `hsl(${idHue(peer.id)} 60% 50%)` }">
            {{ nameInitial(peer.name) }}
            <span class="peer-item__dot ib-online-dot" />
          </div>
          <div class="peer-item__body">
            <div class="peer-item__top">
              <span class="peer-item__name">{{ peer.name }}</span>
              <el-badge v-if="state.unread[peer.id]" :value="state.unread[peer.id]" :max="99" class="peer-item__badge" />
            </div>
            <div class="peer-item__preview">{{ lastPreview(peer.id) }}</div>
          </div>
        </button>
      </div>
    </aside>

    <!-- 右侧：会话 -->
    <section
      class="chat__main"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <template v-if="activePeer">
        <header class="conv-head">
          <div class="conv-head__avatar" :style="{ background: `hsl(${idHue(activePeer.id)} 60% 50%)` }">
            {{ nameInitial(activePeer.name) }}
          </div>
          <div class="conv-head__meta">
            <div class="conv-head__name">{{ activePeer.name }}</div>
            <div class="conv-head__sub">{{ activePeer.ip }}:{{ activePeer.port }} · 在线</div>
          </div>
          <el-button :icon="'Delete'" size="small" text @click="clearChat">清空记录</el-button>
        </header>

        <div ref="scrollRef" class="conv-body">
          <div v-if="messages.length === 0" class="conv-empty">
            <el-icon :size="34"><ChatDotRound /></el-icon>
            <p>开始与 {{ activePeer.name }} 对话</p>
            <span>支持发送文本与文件，文件可直接拖入窗口</span>
          </div>
          <div
            v-for="msg in messages"
            :key="msg.id"
            class="msg"
            :class="msg.dir === 'out' ? 'msg--out' : 'msg--in'"
          >
            <div class="msg__bubble-wrap">
              <!-- 文本 -->
              <div v-if="msg.type === 'text'" class="bubble" :class="msg.dir === 'out' ? 'bubble--out' : 'bubble--in'">
                {{ msg.text }}
              </div>
              <!-- 文件 -->
              <div v-else-if="msg.file" class="file-card" :class="msg.dir === 'out' ? 'file-card--out' : 'file-card--in'">
                <el-image
                  v-if="msg.file.mime.startsWith('image/') && msg.file.url"
                  class="file-card__thumb"
                  :src="msg.file.url"
                  fit="cover"
                  :preview-src-list="[msg.file.url]"
                  preview-teleported
                  lazy
                />
                <div class="file-card__icon">
                  <el-icon :size="22"><Document /></el-icon>
                </div>
                <div class="file-card__meta">
                  <div class="file-card__name" :title="msg.file.name">{{ msg.file.name }}</div>
                  <div class="file-card__size">{{ formatBytes(msg.file.size) }}</div>
                  <div v-if="msg.dir === 'in'" class="file-card__actions">
                    <template v-if="store.downloadByUrl(msg.file.url || '')?.state === 'active'">
                      <el-progress
                        :percentage="downloadPercent(msg)"
                        :stroke-width="4"
                        :show-text="false"
                        style="width: 120px"
                      />
                    </template>
                    <template v-else-if="store.downloadByUrl(msg.file.url || '')?.state === 'done'">
                      <el-button link size="small" type="success" @click="revealDownload(msg)">
                        已保存 · 打开文件夹
                      </el-button>
                    </template>
                    <template v-else>
                      <el-button link size="small" type="primary" @click="downloadFile(msg)">下载</el-button>
                      <el-button v-if="canPreviewModel(msg)" link size="small" @click="previewModel(msg)">3D 预览</el-button>
                    </template>
                  </div>
                </div>
              </div>
              <div class="msg__foot">
                <span class="msg__time">{{ formatChatTime(msg.ts) }}</span>
                <template v-if="msg.dir === 'out'">
                  <span v-if="msg.status === 'sending'" class="msg__status">发送中…</span>
                  <span v-else-if="msg.status === 'failed'" class="msg__status msg__status--fail">
                    发送失败 <button class="msg__retry" @click="retry(msg)">重试</button>
                  </span>
                  <span v-else class="msg__status msg__status--ok">已送达</span>
                </template>
              </div>
            </div>
          </div>
        </div>

        <footer class="composer">
          <el-button :icon="'Paperclip'" circle :disabled="!activePeer" @click="attachFile" />
          <el-input
            v-model="draft"
            type="textarea"
            :rows="1"
            :autosize="{ minRows: 1, maxRows: 5 }"
            resize="none"
            placeholder="输入消息，Enter 发送，Shift+Enter 换行；文件可直接拖入"
            @keydown="onKeydown"
          />
          <el-button type="primary" :icon="'Promotion'" :disabled="!draft.trim()" :loading="sending" @click="send">
            发送
          </el-button>
        </footer>

        <transition name="fade">
          <div v-if="dragOver" class="drop-mask">
            <el-icon :size="40"><UploadFilled /></el-icon>
            <p>松开以发送文件给 {{ activePeer.name }}</p>
          </div>
        </transition>
      </template>

      <div v-else class="chat__placeholder">
        <div class="radar">
          <span class="radar__ring" />
          <span class="radar__ring radar__ring--2" />
          <el-icon :size="30" class="radar__icon"><Connection /></el-icon>
        </div>
        <h3>局域网聊天</h3>
        <p>选择左侧邻居开始对话，支持文本与文件传输</p>
        <span v-if="state.peers.length === 0">正在搜索同一局域网内的设备…</span>
      </div>
    </section>

    <!-- 改名对话框 -->
    <el-dialog v-model="nameDialog" title="修改设备名" width="380px">
      <el-input v-model="nameInput" maxlength="32" placeholder="对外展示的设备名称" @keyup.enter="saveName" />
      <template #footer>
        <el-button @click="nameDialog = false">取消</el-button>
        <el-button type="primary" @click="saveName">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  height: 100vh;
  background: var(--ib-bg);
}

/* ---------- 左栏 ---------- */
.chat__rail {
  width: 280px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--ib-surface);
  border-right: 1px solid var(--ib-border);
}

.self-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px;
  border-bottom: 1px solid var(--ib-border);
}
.self-card__avatar,
.conv-head__avatar,
.peer-item__avatar {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  color: #fff;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 16px;
}
.self-card__meta {
  flex: 1;
  min-width: 0;
}
.self-card__name {
  font-weight: 700;
  font-size: 14px;
  color: var(--ib-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.self-card__addr {
  display: flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  font-size: 11.5px;
  color: var(--ib-ink-3);
  font-family: inherit;
}

.rail-service {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid var(--ib-border);
}
.rail-service__label {
  font-size: 12.5px;
  color: var(--ib-ink-2);
}

.rail-label {
  padding: 12px 16px 6px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1px;
  color: var(--ib-ink-3);
}

.peer-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px 12px;
}
.peer-empty__title {
  margin: 0;
  font-size: 13px;
  color: var(--ib-ink-2);
}
.peer-empty__hint {
  margin: 4px 0 0;
  font-size: 11.5px;
  color: var(--ib-ink-3);
}

.peer-item {
  display: flex;
  gap: 10px;
  align-items: center;
  width: 100%;
  padding: 10px;
  border-radius: 12px;
  border: 1px solid transparent;
  background: none;
  cursor: pointer;
  text-align: left;
  transition: all 0.15s;
  font-family: inherit;
}
.peer-item:hover {
  background: var(--ib-surface-2);
}
.peer-item--active {
  background: linear-gradient(120deg, #eef1ff, #f6f1ff);
  border-color: #d9e0ff;
}
.peer-item__avatar {
  position: relative;
  width: 38px;
  height: 38px;
  font-size: 15px;
}
.peer-item__dot {
  position: absolute;
  right: -2px;
  bottom: -2px;
  border: 2px solid #fff;
}
.peer-item__body {
  flex: 1;
  min-width: 0;
}
.peer-item__top {
  display: flex;
  align-items: center;
  gap: 6px;
}
.peer-item__name {
  flex: 1;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ib-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.peer-item__preview {
  font-size: 11.5px;
  color: var(--ib-ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 2px;
}

/* ---------- 会话 ---------- */
.chat__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}

.conv-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--ib-border);
  background: var(--ib-surface);
}
.conv-head__meta {
  flex: 1;
}
.conv-head__name {
  font-weight: 700;
  font-size: 15px;
  color: var(--ib-ink);
}
.conv-head__sub {
  font-size: 12px;
  color: var(--ib-green);
}

.conv-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.conv-empty {
  margin: auto;
  text-align: center;
  color: var(--ib-ink-3);
}
.conv-empty p {
  margin: 10px 0 4px;
  font-size: 14px;
  color: var(--ib-ink-2);
}
.conv-empty span {
  font-size: 12px;
}

.msg {
  display: flex;
  animation: ib-bubble 0.24s ease both;
}
.msg--out {
  justify-content: flex-end;
}
.msg__bubble-wrap {
  max-width: 62%;
  display: flex;
  flex-direction: column;
}
.msg--out .msg__bubble-wrap {
  align-items: flex-end;
}

.bubble {
  padding: 10px 14px;
  border-radius: 14px;
  font-size: 14px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}
.bubble--in {
  background: var(--ib-surface);
  border: 1px solid var(--ib-border);
  color: var(--ib-ink);
  border-top-left-radius: 4px;
}
.bubble--out {
  background: linear-gradient(135deg, #4f6bff, #6a5bff);
  color: #fff;
  border-top-right-radius: 4px;
  box-shadow: 0 4px 14px rgba(79, 107, 255, 0.28);
}

.file-card {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 12px;
  border-radius: 14px;
  min-width: 240px;
  position: relative;
  overflow: hidden;
}
.file-card--in {
  background: var(--ib-surface);
  border: 1px solid var(--ib-border);
}
.file-card--out {
  background: #eef1ff;
  border: 1px solid #d9e0ff;
}
.file-card__thumb {
  width: 56px;
  height: 56px;
  border-radius: 9px;
  flex-shrink: 0;
}
.file-card__icon {
  width: 42px;
  height: 42px;
  border-radius: 10px;
  background: linear-gradient(135deg, #4f6bff, #17c3e6);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.file-card__meta {
  min-width: 0;
  flex: 1;
}
.file-card__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--ib-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-card__size {
  font-size: 11.5px;
  color: var(--ib-ink-3);
}
.file-card__actions {
  margin-top: 4px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.msg__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--ib-ink-3);
}
.msg__status--ok {
  color: var(--ib-green);
}
.msg__status--fail {
  color: var(--ib-danger);
}
.msg__retry {
  border: none;
  background: none;
  color: var(--ib-indigo);
  cursor: pointer;
  font-size: 11px;
  text-decoration: underline;
  font-family: inherit;
  padding: 0;
}

.composer {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--ib-border);
  background: var(--ib-surface);
}
.composer .el-input {
  flex: 1;
}

.drop-mask {
  position: absolute;
  inset: 0;
  background: rgba(79, 107, 255, 0.12);
  backdrop-filter: blur(2px);
  border: 2px dashed var(--ib-indigo);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--ib-indigo);
  z-index: 10;
  pointer-events: none;
}
.drop-mask p {
  font-size: 15px;
  font-weight: 600;
}

/* ---------- 占位 ---------- */
.chat__placeholder {
  margin: auto;
  text-align: center;
  color: var(--ib-ink-3);
}
.chat__placeholder h3 {
  margin: 18px 0 6px;
  color: var(--ib-ink);
  font-size: 18px;
}
.chat__placeholder p {
  margin: 0 0 6px;
  font-size: 13px;
}
.chat__placeholder span {
  font-size: 12px;
}
.radar {
  position: relative;
  width: 90px;
  height: 90px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
}
.radar__ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 2px solid rgba(79, 107, 255, 0.4);
  animation: radar-ping 2.4s ease-out infinite;
}
.radar__ring--2 {
  animation-delay: 1.2s;
}
.radar__icon {
  color: var(--ib-indigo);
}
@keyframes radar-ping {
  0% {
    transform: scale(0.4);
    opacity: 0.9;
  }
  100% {
    transform: scale(1.1);
    opacity: 0;
  }
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.18s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>