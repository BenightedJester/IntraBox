import { reactive, computed } from 'vue'
import type {
  ChatMessage,
  DownloadProgress,
  HistoryEntry,
  HistoryLists,
  PeerInfo,
  PendingOpen,
  SelfInfo,
  ShareInfo,
  ViewerSource,
} from '../shared/lan-types'
import { HISTORY_LIMIT, historyKey } from '../shared/lan-types'

/**
 * 全局局域网状态（单例）。
 * 在 App.vue 中初始化一次，跨页面共享：邻居、消息、共享、下载、未读。
 * 所有数据以主进程事件为唯一来源，避免双重写入。
 */
interface LanState {
  ready: boolean
  /** 是否运行在 Electron 中（浏览器直接访问时为 false） */
  native: boolean
  self: SelfInfo
  peers: PeerInfo[]
  shares: ShareInfo[]
  messages: ChatMessage[]
  downloads: DownloadProgress[]
  unread: Record<string, number>
  activePeerId: string | null
  drafts: Record<string, string>
  pendingOpen: PendingOpen | null
  history: HistoryLists
}

const state = reactive<LanState>({
  ready: false,
  native: typeof window !== 'undefined' && !!window.api,
  self: { id: '', name: '', port: 0, ips: [], running: false, version: '' },
  peers: [],
  shares: [],
  messages: [],
  downloads: [],
  unread: {},
  activePeerId: null,
  drafts: {},
  pendingOpen: null,
  history: { model: [], tiles: [] },
})

let initialized = false
/** ChatView 挂载时设置，用于判断消息是否应计入未读 */
let focusedChatPeerId: string | null = null

function upsertMessage(msg: ChatMessage) {
  const idx = state.messages.findIndex((m) => m.id === msg.id)
  if (idx >= 0) state.messages[idx] = msg
  else state.messages.push(msg)
}

function countUnread(msg: ChatMessage) {
  if (msg.dir !== 'in') return
  const isViewing =
    focusedChatPeerId === msg.peerId &&
    typeof document !== 'undefined' &&
    document.hasFocus()
  if (!isViewing) {
    state.unread[msg.peerId] = (state.unread[msg.peerId] ?? 0) + 1
  }
}

export function useLanStore() {
  async function init() {
    if (initialized) return
    initialized = true
    if (!state.native) {
      state.ready = true
      return
    }
    const api = window.api
    try {
      const data = await api.lan.getState()
      state.self = data.self
      state.peers = data.peers
      state.shares = data.shares
      state.messages = data.messages
      state.history = await api.lan.history()
    } catch (err) {
      console.error('[store] 初始化失败', err)
    }

    api.on('lan:self', (self: SelfInfo) => {
      state.self = self
    })
    api.on('lan:peers', (peers: PeerInfo[]) => {
      state.peers = peers
    })
    api.on('lan:shares', (shares: ShareInfo[]) => {
      state.shares = shares
    })
    api.on('chat:message', (msg: ChatMessage) => {
      upsertMessage(msg)
      countUnread(msg)
    })
    api.on('chat:status', (p: { peerId: string; id: string; status: ChatMessage['status'] }) => {
      const msg = state.messages.find((m) => m.id === p.id)
      if (msg) msg.status = p.status
    })
    api.on('chat:cleared', (p: { peerId: string }) => {
      state.messages = state.messages.filter((m) => m.peerId !== p.peerId)
      state.unread[p.peerId] = 0
    })
    api.on('download:progress', (p: DownloadProgress) => {
      const idx = state.downloads.findIndex((d) => d.id === p.id)
      if (idx >= 0) state.downloads[idx] = p
      else {
        state.downloads.unshift(p)
        if (state.downloads.length > 30) state.downloads.length = 30
      }
    })

    state.ready = true
  }

  // ---------------- 聊天 ----------------
  function setActivePeer(peerId: string | null) {
    state.activePeerId = peerId
    focusedChatPeerId = peerId
    if (peerId) state.unread[peerId] = 0
  }

  function chatFocused(on: boolean) {
    focusedChatPeerId = on ? state.activePeerId : null
    if (on && state.activePeerId) state.unread[state.activePeerId] = 0
  }

  const activeMessages = computed(() =>
    state.messages
      .filter((m) => m.peerId === state.activePeerId)
      .sort((a, b) => a.ts - b.ts),
  )

  function peerById(id: string | null): PeerInfo | undefined {
    return state.peers.find((p) => p.id === id)
  }

  function lastMessageOf(peerId: string): ChatMessage | undefined {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].peerId === peerId) return state.messages[i]
    }
    return undefined
  }

  async function sendText(text: string) {
    const peerId = state.activePeerId
    if (!peerId || !text.trim()) return
    state.drafts[peerId] = ''
    await window.api.chat.sendText(peerId, text.trim())
  }

  async function sendFilePaths(paths: string[]) {
    const peerId = state.activePeerId
    if (!peerId) return
    for (const p of paths) {
      await window.api.chat.sendFilePath(peerId, p)
    }
  }

  async function pickAndSendFile() {
    if (!state.activePeerId) return
    await window.api.chat.pickAndSend(state.activePeerId)
  }

  async function retryMessage(msg: ChatMessage) {
    await window.api.chat.retry(msg.peerId, msg.id)
  }

  async function clearConversation(peerId: string) {
    await window.api.chat.clear(peerId)
  }

  // ---------------- 下载 ----------------
  async function startDownload(url: string, name: string, saveAs = true) {
    return window.api.download.start(url, name, saveAs)
  }

  function downloadByUrl(url: string): DownloadProgress | undefined {
    return state.downloads.find((d) => d.url === url)
  }

  // ---------------- 查看器跳转 ----------------
  function requestOpen(pending: PendingOpen) {
    state.pendingOpen = pending
  }

  function takePendingOpen(viewer: 'model' | 'tiles'): PendingOpen | null {
    if (state.pendingOpen?.viewer === viewer) {
      const p = state.pendingOpen
      state.pendingOpen = null
      return p
    }
    return null
  }

  // ---------------- 查看器历史 ----------------
  /** 记录一次成功打开（所有来源），同一入口去重置顶（复用原条目 id，保持稳定） */
  async function pushHistory(viewer: 'model' | 'tiles', source: ViewerSource) {
    const entry: HistoryEntry = {
      id: crypto.randomUUID(),
      kind: source.kind,
      name: source.name,
      baseUrl: source.kind === 'local' ? '' : source.baseUrl,
      relPath: source.relPath,
      root: source.root,
      localPath: source.localPath,
      originLabel: source.originLabel,
      ts: Date.now(),
    }
    const key = historyKey(entry)
    const prev = state.history[viewer].find((e) => historyKey(e) === key)
    if (prev) entry.id = prev.id
    const list = state.history[viewer].filter((e) => historyKey(e) !== key)
    list.unshift(entry)
    state.history[viewer] = list.slice(0, HISTORY_LIMIT)
    try {
      await window.api.lan.pushHistory(viewer, entry)
    } catch (err) {
      console.error('[store] 写入历史失败', err)
    }
  }

  async function removeHistory(viewer: 'model' | 'tiles', id: string) {
    state.history[viewer] = state.history[viewer].filter((e) => e.id !== id)
    await window.api.lan.removeHistory(viewer, id)
  }

  async function clearHistory(viewer: 'model' | 'tiles') {
    state.history[viewer] = []
    await window.api.lan.clearHistory(viewer)
  }

  const onlinePeers = computed(() => state.peers)
  const totalUnread = computed(() =>
    Object.values(state.unread).reduce((a, b) => a + b, 0),
  )

  return {
    state,
    init,
    setActivePeer,
    chatFocused,
    activeMessages,
    peerById,
    lastMessageOf,
    sendText,
    sendFilePaths,
    pickAndSendFile,
    retryMessage,
    clearConversation,
    startDownload,
    downloadByUrl,
    requestOpen,
    takePendingOpen,
    pushHistory,
    removeHistory,
    clearHistory,
    onlinePeers,
    totalUnread,
  }
}