import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { app, dialog, shell, type BrowserWindow } from 'electron'
import type {
  ChatMessage,
  DirListing,
  DownloadProgress,
  FileIndex,
  PeerInfo,
  PublicShare,
  SelfInfo,
  ShareInfo,
} from '../../src/shared/lan-types'
import { Settings } from './settings'
import { Discovery } from './discovery'
import { createLanServer, listenWithRetry, type OutgoingFile } from './http'
import { lanIPv4s, mimeOf, safeJoin } from './fs-utils'

const PREFERRED_PORT = 41778
const HISTORY_LIMIT = 1000

interface ActiveDownload {
  req: http.ClientRequest | null
  dest: string
  canceled: boolean
}

/**
 * 局域网服务编排：设置 / 发现 / HTTP / 聊天 / 共享 / 下载。
 * 通过 EventEmitter 向主进程转发事件，再由 IPC 推给渲染进程。
 */
export class LanService extends EventEmitter {
  settings: Settings
  private discovery: Discovery | null = null
  private server: http.Server | null = null
  private port = 0
  private running = false
  private history: ChatMessage[] = []
  private seenIds = new Set<string>()
  private outgoing = new Map<string, OutgoingFile>()
  private downloads = new Map<string, ActiveDownload>()
  private getWindow: () => BrowserWindow | null
  private appDir: string | null

  constructor(userDataDir: string, getWindow: () => BrowserWindow | null, appDir: string | null) {
    super()
    this.settings = new Settings(userDataDir)
    this.getWindow = getWindow
    this.appDir = appDir
  }

  // ---------------- 生命周期 ----------------

  async start() {
    if (this.running) return
    const server = createLanServer({
      getInfo: () => ({
        id: this.settings.data.id,
        name: this.settings.data.name,
        port: this.port,
        version: app.getVersion(),
      }),
      getShares: () => this.publicShares(),
      getShareRoot: (id) => {
        const share = this.settings.data.shares.find((s) => s.id === id && s.enabled)
        return share && fs.existsSync(share.path) ? share.path : null
      },
      receiveChat: (body, ip) => this.receiveChat(body, ip),
      getOutgoingFile: (id) => this.outgoing.get(id) ?? null,
      appDir: this.appDir,
    })
    this.port = await listenWithRetry(server, PREFERRED_PORT)
    this.server = server

    this.discovery = new Discovery(this.settings.data.id, this.settings.data.name, this.port)
    this.discovery.on('peers', (peers: PeerInfo[]) => this.emit('lan:peers', peers))
    this.discovery.start()

    this.running = true
    this.emitSelf()
    console.log(`[lan] 服务已启动，端口 ${this.port}，设备 ${this.settings.data.name}`)
  }

  async stop() {
    if (!this.running) return
    this.running = false
    this.discovery?.stop()
    this.discovery = null
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve()
      this.server.close(() => resolve())
      // 强制断开 keep-alive 连接，避免 close 挂起
      this.server.closeAllConnections?.()
    })
    this.server = null
    for (const [id] of this.downloads) this.cancelDownload(id)
    this.emitSelf()
    this.emit('lan:peers', [])
  }

  async setRunning(on: boolean) {
    this.settings.data.serviceEnabled = on
    this.settings.save()
    if (on) await this.start()
    else await this.stop()
  }

  selfInfo(): SelfInfo {
    return {
      id: this.settings.data.id,
      name: this.settings.data.name,
      port: this.port,
      ips: lanIPv4s(),
      running: this.running,
      version: app.getVersion(),
    }
  }

  private emitSelf() {
    this.emit('lan:self', this.selfInfo())
  }

  setName(name: string) {
    const trimmed = name.trim().slice(0, 32)
    if (!trimmed) return
    this.settings.data.name = trimmed
    this.settings.save()
    this.discovery?.setSelf(trimmed, this.port)
    this.emitSelf()
  }

  peers(): PeerInfo[] {
    return this.discovery?.list() ?? []
  }

  // ---------------- 共享文件夹 ----------------

  shares(): ShareInfo[] {
    return this.settings.data.shares
  }

  private publicShares(): PublicShare[] {
    return this.settings.data.shares
      .filter((s) => s.enabled && fs.existsSync(s.path))
      .map((s) => ({ id: s.id, name: s.name }))
  }

  private emitShares() {
    this.settings.save()
    this.emit('lan:shares', this.shares())
  }

  async addShare(): Promise<ShareInfo[] | null> {
    const win = this.getWindow()
    const result = await dialog.showOpenDialog(win!, {
      title: '选择要共享的文件夹',
      properties: ['openDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const dir = result.filePaths[0]
    if (this.settings.data.shares.some((s) => s.path === dir)) {
      return this.shares()
    }
    this.settings.data.shares.push({
      id: randomUUID().slice(0, 10),
      name: path.basename(dir),
      path: dir,
      enabled: true,
    })
    this.emitShares()
    return this.shares()
  }

  removeShare(id: string) {
    this.settings.data.shares = this.settings.data.shares.filter((s) => s.id !== id)
    this.emitShares()
  }

  toggleShare(id: string, enabled: boolean) {
    const share = this.settings.data.shares.find((s) => s.id === id)
    if (share) {
      share.enabled = enabled
      this.emitShares()
    }
  }

  renameShare(id: string, name: string) {
    const share = this.settings.data.shares.find((s) => s.id === id)
    const trimmed = name.trim().slice(0, 40)
    if (share && trimmed) {
      share.name = trimmed
      this.emitShares()
    }
  }

  revealShare(id: string) {
    const share = this.settings.data.shares.find((s) => s.id === id)
    if (share) shell.openPath(share.path)
  }

  /** 共享的本机访问 URL 前缀 */
  shareUrl(id: string): string {
    const ip = lanIPv4s()[0] ?? '127.0.0.1'
    return `http://${ip}:${this.port}/share/${id}/fs/`
  }

  // ---------------- 邻居文件访问（HTTP 客户端） ----------------

  private peerBase(peerId: string): string {
    const peer = this.discovery?.get(peerId)
    if (!peer) throw new Error('对方不在线或已离开局域网')
    return `http://${peer.ip}:${peer.port}`
  }

  private fetchJson<T>(url: string, timeout = 10000): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = http.get(url, { timeout }, (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`请求失败（HTTP ${res.statusCode}）`))
          return
        }
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as T)
          } catch {
            reject(new Error('响应解析失败'))
          }
        })
        res.on('error', reject)
      })
      req.on('timeout', () => {
        req.destroy(new Error('连接超时'))
      })
      req.on('error', reject)
    })
  }

  async peerShares(peerId: string): Promise<PublicShare[]> {
    const data = await this.fetchJson<{ shares: PublicShare[] }>(`${this.peerBase(peerId)}/api/shares`)
    return data.shares ?? []
  }

  async peerList(peerId: string, shareId: string, relPath: string): Promise<DirListing> {
    const url = `${this.peerBase(peerId)}/api/shares/${shareId}/list?path=${encodeURIComponent(relPath)}`
    return this.fetchJson<DirListing>(url)
  }

  async peerIndex(peerId: string, shareId: string): Promise<FileIndex> {
    return this.fetchJson<FileIndex>(`${this.peerBase(peerId)}/api/shares/${shareId}/index`, 30000)
  }

  // ---------------- 聊天 ----------------

  messages(): ChatMessage[] {
    return this.history
  }

  private pushMessage(msg: ChatMessage) {
    this.history.push(msg)
    if (this.history.length > HISTORY_LIMIT) {
      this.history.splice(0, this.history.length - HISTORY_LIMIT)
    }
    this.seenIds.add(msg.id)
    if (this.seenIds.size > 3000) {
      const arr = [...this.seenIds]
      this.seenIds = new Set(arr.slice(arr.length - 1500))
    }
    this.emit('chat:message', msg)
    // 收到消息且窗口未聚焦时闪烁任务栏
    const win = this.getWindow()
    if (msg.dir === 'in' && win && !win.isFocused()) {
      win.flashFrame(true)
    }
  }

  private postMessage(peerId: string, payload: Record<string, unknown>): Promise<void> {
    const base = this.peerBase(peerId)
    const body = JSON.stringify(payload)
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${base}/api/chat/message`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: 8000,
        },
        (res) => {
          res.resume()
          if (res.statusCode === 200) resolve()
          else reject(new Error(`对方返回 HTTP ${res.statusCode}`))
        },
      )
      req.on('timeout', () => req.destroy(new Error('发送超时')))
      req.on('error', reject)
      req.end(body)
    })
  }

  private wirePayload(msg: ChatMessage) {
    return {
      app: 'intrabox',
      id: msg.id,
      from: { id: this.settings.data.id, name: this.settings.data.name, port: this.port },
      type: msg.type,
      text: msg.text,
      file: msg.file ? { fileId: msg.file.fileId, name: msg.file.name, size: msg.file.size, mime: msg.file.mime } : undefined,
      ts: msg.ts,
    }
  }

  async sendText(peerId: string, text: string): Promise<ChatMessage> {
    const peer = this.discovery?.get(peerId)
    const msg: ChatMessage = {
      id: randomUUID(),
      peerId,
      peerName: peer?.name ?? peerId.slice(0, 8),
      dir: 'out',
      type: 'text',
      text: text.slice(0, 8000),
      ts: Date.now(),
      status: 'sending',
    }
    this.pushMessage(msg)
    try {
      await this.postMessage(peerId, this.wirePayload(msg))
      this.setStatus(peerId, msg.id, 'sent')
    } catch (err) {
      console.warn('[chat] 发送失败', err)
      this.setStatus(peerId, msg.id, 'failed')
    }
    return msg
  }

  async sendFile(peerId: string, filePath: string): Promise<ChatMessage> {
    const st = fs.statSync(filePath)
    if (!st.isFile()) throw new Error('只能发送文件')
    const peer = this.discovery?.get(peerId)
    const fileId = randomUUID()
    const meta = {
      fileId,
      name: path.basename(filePath),
      size: st.size,
      mime: mimeOf(filePath),
    }
    this.outgoing.set(fileId, { path: filePath, ...meta })
    const msg: ChatMessage = {
      id: randomUUID(),
      peerId,
      peerName: peer?.name ?? peerId.slice(0, 8),
      dir: 'out',
      type: 'file',
      file: meta,
      ts: Date.now(),
      status: 'sending',
    }
    this.pushMessage(msg)
    try {
      await this.postMessage(peerId, this.wirePayload(msg))
      this.setStatus(peerId, msg.id, 'sent')
    } catch (err) {
      console.warn('[chat] 文件消息发送失败', err)
      this.setStatus(peerId, msg.id, 'failed')
    }
    return msg
  }

  async retry(peerId: string, id: string) {
    const msg = this.history.find((m) => m.id === id && m.peerId === peerId)
    if (!msg || msg.dir !== 'out') return
    this.setStatus(peerId, id, 'sending')
    try {
      await this.postMessage(peerId, this.wirePayload(msg))
      this.setStatus(peerId, id, 'sent')
    } catch {
      this.setStatus(peerId, id, 'failed')
    }
  }

  private setStatus(peerId: string, id: string, status: ChatMessage['status']) {
    const msg = this.history.find((m) => m.id === id)
    if (msg) msg.status = status
    this.emit('chat:status', { peerId, id, status })
  }

  clearHistory(peerId: string) {
    this.history = this.history.filter((m) => m.peerId !== peerId)
    this.emit('chat:cleared', { peerId })
  }

  /** HTTP 收到邻居消息 */
  private receiveChat(body: unknown, remoteIp: string): { ok: boolean; error?: string } {
    const data = body as {
      app?: string
      id?: string
      from?: { id?: string; name?: string; port?: number }
      type?: string
      text?: string
      file?: { fileId?: string; name?: string; size?: number; mime?: string }
      ts?: number
    }
    if (data.app !== 'intrabox' || !data.id || !data.from?.id) return { ok: false, error: '无效消息' }
    if (data.from.id === this.settings.data.id) return { ok: false, error: '不能给自己发消息' }
    if (this.seenIds.has(data.id)) return { ok: true }
    const peerName = String(data.from.name || data.from.id.slice(0, 8))
    // 即时登记对方，聊天无需等待发现信标
    if (typeof data.from.port === 'number' && remoteIp) {
      this.discovery?.upsertFromMessage(data.from.id, peerName, remoteIp, data.from.port)
    }
    const msg: ChatMessage = {
      id: data.id,
      peerId: data.from.id,
      peerName,
      dir: 'in',
      type: data.type === 'file' ? 'file' : 'text',
      text: typeof data.text === 'string' ? data.text : undefined,
      ts: typeof data.ts === 'number' ? data.ts : Date.now(),
    }
    if (msg.type === 'file' && data.file?.fileId) {
      msg.file = {
        fileId: data.file.fileId,
        name: String(data.file.name || '文件'),
        size: Number(data.file.size) || 0,
        mime: String(data.file.mime || 'application/octet-stream'),
        url: `http://${remoteIp}:${data.from.port}/api/chat/file/${data.file.fileId}`,
      }
    }
    this.pushMessage(msg)
    return { ok: true }
  }

  // ---------------- 下载 ----------------

  async startDownload(url: string, name: string, saveAs: boolean): Promise<{ id: string } | null> {
    let dest: string
    if (saveAs) {
      const win = this.getWindow()
      const result = await dialog.showSaveDialog(win!, {
        title: '保存文件',
        defaultPath: path.join(app.getPath('downloads'), name),
      })
      if (result.canceled || !result.filePath) return null
      dest = result.filePath
    } else {
      dest = uniquePath(path.join(app.getPath('downloads'), name))
    }
    const id = randomUUID()
    const active: ActiveDownload = { req: null, dest, canceled: false }
    this.downloads.set(id, active)
    const progress: DownloadProgress = { id, url, name, received: 0, total: 0, state: 'active' }
    this.emit('download:progress', { ...progress })
    this.runDownload(id, url, dest, progress, 0)
    return { id }
  }

  private runDownload(id: string, url: string, dest: string, progress: DownloadProgress, redirects: number) {
    const active = this.downloads.get(id)
    if (!active || active.canceled) return
    const mod = url.startsWith('https') ? https : http
    const tmp = dest + '.intrabox-part'
    const req = mod.get(url, { timeout: 30000 }, (res) => {
      // 跟随重定向
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        if (redirects >= 5) {
          this.finishDownload(id, progress, 'error', '重定向次数过多')
          return
        }
        const next = new URL(res.headers.location, url).toString()
        this.runDownload(id, next, dest, progress, redirects + 1)
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        this.finishDownload(id, progress, 'error', `HTTP ${res.statusCode}（文件可能已失效）`)
        return
      }
      progress.total = parseInt(res.headers['content-length'] ?? '0', 10) || 0
      const out = fs.createWriteStream(tmp)
      let lastEmit = 0
      res.on('data', (chunk: Buffer) => {
        progress.received += chunk.length
        const now = Date.now()
        if (now - lastEmit > 120) {
          lastEmit = now
          this.emit('download:progress', { ...progress })
        }
      })
      res.pipe(out)
      out.on('error', (err) => this.finishDownload(id, progress, 'error', String(err.message)))
      out.on('finish', () => {
        if (active.canceled) {
          fs.rmSync(tmp, { force: true })
          this.finishDownload(id, progress, 'canceled')
          return
        }
        try {
          fs.renameSync(tmp, dest)
          progress.path = dest
          this.finishDownload(id, progress, 'done')
        } catch (err) {
          this.finishDownload(id, progress, 'error', String((err as Error).message))
        }
      })
      res.on('error', (err) => {
        out.destroy()
        fs.rmSync(tmp, { force: true })
        if (!active.canceled) this.finishDownload(id, progress, 'error', String(err.message))
      })
    })
    active.req = req
    req.on('timeout', () => req.destroy(new Error('下载超时')))
    req.on('error', (err) => {
      fs.rmSync(tmp, { force: true })
      if (!active.canceled) this.finishDownload(id, progress, 'error', String(err.message))
      else this.finishDownload(id, progress, 'canceled')
    })
  }

  private finishDownload(id: string, progress: DownloadProgress, state: DownloadProgress['state'], error?: string) {
    progress.state = state
    progress.error = error
    this.downloads.delete(id)
    this.emit('download:progress', { ...progress })
  }

  cancelDownload(id: string) {
    const active = this.downloads.get(id)
    if (!active) return
    active.canceled = true
    active.req?.destroy()
  }

  revealPath(p: string) {
    if (fs.existsSync(p)) shell.showItemInFolder(p)
  }

  openPath(p: string) {
    if (fs.existsSync(p)) shell.openPath(p)
  }

  /** 校验路径是否位于某个共享内（用于“在查看器中打开”等场景） */
  isWithinShare(shareId: string, rel: string): boolean {
    const share = this.settings.data.shares.find((s) => s.id === shareId)
    if (!share) return false
    return safeJoin(share.path, rel) !== null
  }
}

function uniquePath(p: string): string {
  if (!fs.existsSync(p)) return p
  const dir = path.dirname(p)
  const ext = path.extname(p)
  const base = path.basename(p, ext)
  for (let i = 1; i < 1000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`)
    if (!fs.existsSync(candidate)) return candidate
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`)
}