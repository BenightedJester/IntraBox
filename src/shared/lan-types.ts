/**
 * 主进程与渲染进程共享的局域网 / 查看器类型与常量。
 * 仅包含纯类型与常量，可被两端安全引用。
 */

// ---------------- 局域网基础 ----------------

export interface ShareInfo {
  id: string
  name: string
  path: string
  enabled: boolean
}

/** 对外（邻居）可见的共享信息，不暴露本机绝对路径 */
export interface PublicShare {
  id: string
  name: string
}

export interface PeerInfo {
  id: string
  name: string
  ip: string
  port: number
  lastSeen: number
}

export interface SelfInfo {
  id: string
  name: string
  port: number
  ips: string[]
  running: boolean
  version: string
}

// ---------------- 聊天 ----------------

export type ChatMessageStatus = 'sending' | 'sent' | 'failed'

export interface ChatFileMeta {
  fileId: string
  name: string
  size: number
  mime: string
  /** 接收方补全的下载地址（指向发送方的 HTTP 服务） */
  url?: string
}

export interface ChatMessage {
  id: string
  peerId: string
  peerName: string
  dir: 'in' | 'out'
  type: 'text' | 'file'
  text?: string
  file?: ChatFileMeta
  ts: number
  /** 仅 outgoing 消息有发送状态 */
  status?: ChatMessageStatus
}

export interface ChatState {
  self: SelfInfo
  peers: PeerInfo[]
  shares: ShareInfo[]
  messages: ChatMessage[]
}

// ---------------- 文件浏览 / 下载 ----------------

export interface FileEntry {
  name: string
  size: number
  mtime: number
  dir: boolean
}

export interface DirListing {
  /** 当前相对路径（posix 风格，'' 表示根） */
  path: string
  entries: FileEntry[]
  truncated: boolean
}

export interface IndexFile {
  /** 相对共享根目录的 posix 路径 */
  p: string
  /** 字节数 */
  s: number
}

export interface FileIndex {
  files: IndexFile[]
  truncated: boolean
}

export type DownloadState = 'active' | 'done' | 'error' | 'canceled'

export interface DownloadProgress {
  id: string
  url: string
  name: string
  path?: string
  received: number
  total: number
  state: DownloadState
  error?: string
}

// ---------------- 三维查看器 ----------------

/** 模型查看器支持的入口文件扩展名 */
export const MODEL_EXTS = ['gltf', 'glb', 'obj', 'fbx', 'stl', 'ply', 'dae'] as const

/** 3D Tiles 入口（tileset.json） */
export const TILESET_EXTS = ['json'] as const

export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

export function isModelFile(name: string): boolean {
  return (MODEL_EXTS as readonly string[]).includes(extOf(name))
}

export function isTilesetFile(name: string): boolean {
  return extOf(name) === 'json'
}

/** 本地打开的模型根目录信息（含文件索引与候选入口） */
export interface LocalRootInfo {
  token: string
  root: string
  name: string
  files: IndexFile[]
  truncated: boolean
  candidates: IndexFile[]
}

/**
 * 统一的模型/瓦片数据源描述。
 * baseUrl 以 '/' 结尾，relPath 为入口文件相对 baseUrl 的原始（未编码）posix 路径。
 */
export interface ViewerSource {
  kind: 'local' | 'lan' | 'url'
  baseUrl: string
  relPath: string
  name: string
  /** 资源索引（小写相对路径 -> 原始相对路径），用于外部资源容错解析 */
  files?: IndexFile[]
  truncated?: boolean
  /** 数据来源描述，用于界面展示 */
  originLabel: string
  /** 仅 local：资源根目录的本机绝对路径（用于历史记录跨重启重开） */
  root?: string
  /** 仅 local：入口文件的本机绝对路径 */
  localPath?: string
}

export interface PendingOpen {
  viewer: 'model' | 'tiles'
  source: ViewerSource
}

// ---------------- 查看器历史 ----------------

/** 查看器打开历史条目（持久化，跨重启可重开） */
export interface HistoryEntry {
  id: string
  kind: 'local' | 'lan' | 'url'
  /** 入口文件名 */
  name: string
  /** url / lan：以 '/' 结尾的基地址；local 为空串 */
  baseUrl: string
  /** 入口相对 baseUrl 的原始 posix 路径 */
  relPath: string
  /** 仅 local：资源根目录绝对路径 */
  root?: string
  /** 仅 local：入口文件绝对路径 */
  localPath?: string
  originLabel: string
  /** 最近一次打开时间 */
  ts: number
}

export interface HistoryLists {
  model: HistoryEntry[]
  tiles: HistoryEntry[]
}

/** 历史记录条数上限 */
export const HISTORY_LIMIT = 30

/** 历史条目去重键：同一来源的同一入口只保留最新一条 */
export function historyKey(e: Pick<HistoryEntry, 'kind' | 'baseUrl' | 'relPath' | 'localPath'>): string {
  if (e.kind === 'local') return `local:${(e.localPath ?? e.relPath).toLowerCase()}`
  return `${e.kind}:${(e.baseUrl + e.relPath).toLowerCase()}`
}

// ---------------- 事件通道 ----------------

export const LAN_EVENTS = [
  'lan:self',
  'lan:peers',
  'lan:shares',
  'chat:message',
  'chat:status',
  'chat:cleared',
  'download:progress',
] as const

export type LanEventChannel = (typeof LAN_EVENTS)[number]