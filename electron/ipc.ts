import { ipcMain, dialog, app, type BrowserWindow } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import type { LanService } from './lan/service'
import type { ModelRoots } from './lan/modelRoots'
import type { AppSettingsView, CloseAction, HistoryEntry, LocalRootInfo, ViewerSource } from '../src/shared/lan-types'

/** 注册局域网 / 查看器相关 IPC。所有 handler 统一捕获异常并抛出给渲染端。 */
export function registerLanIpc(
  service: LanService,
  roots: ModelRoots,
  getWindow: () => BrowserWindow | null,
) {
  const handle = (channel: string, fn: (...args: any[]) => unknown) => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await fn(...args)
      } catch (err) {
        console.error(`[ipc] ${channel} 失败`, err)
        throw err instanceof Error ? err.message : String(err)
      }
    })
  }

  // ---------------- 状态 / 设置 ----------------
  handle('lan:get-state', () => ({
    self: service.selfInfo(),
    peers: service.peers(),
    shares: service.shares(),
    messages: service.messages(),
  }))
  handle('lan:set-name', (name: string) => {
    service.setName(name)
    return service.selfInfo()
  })
  handle('lan:set-running', async (on: boolean) => {
    await service.setRunning(on)
    return service.selfInfo()
  })
  handle('lan:history', () => service.settings.data.history)
  handle('lan:push-history', (kind: 'model' | 'tiles', entry: HistoryEntry) => {
    service.settings.pushHistory(kind, entry)
  })
  handle('lan:remove-history', (kind: 'model' | 'tiles', id: string) => {
    service.settings.removeHistory(kind, id)
  })
  handle('lan:clear-history', (kind: 'model' | 'tiles') => {
    service.settings.clearHistory(kind)
  })

  // ---------------- 应用设置（关闭行为 / 开机自启） ----------------
  // 便携版 exe 是自解压壳，自启须注册真实 exe 路径（与 main.ts syncAutoStart 一致）
  const autoStartExePath = () => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
  handle('settings:get', (): AppSettingsView => ({
    closeAction: service.settings.data.closeAction,
    autoStart: service.settings.data.autoStart,
    autoStartSupported: app.isPackaged,
    isPortable: !!process.env.PORTABLE_EXECUTABLE_FILE,
  }))
  handle('settings:set-close-action', (action: CloseAction) => {
    if (action !== 'ask' && action !== 'hide' && action !== 'quit') throw new Error('无效的关闭行为')
    service.settings.data.closeAction = action
    service.settings.save()
  })
  handle('settings:set-auto-start', (on: boolean) => {
    if (!app.isPackaged) throw new Error('开发模式不支持开机自启，请使用打包后的应用')
    app.setLoginItemSettings({ openAtLogin: on, path: autoStartExePath() })
    const actual = app.getLoginItemSettings({ path: autoStartExePath() }).openAtLogin
    service.settings.data.autoStart = actual
    service.settings.save()
    return actual
  })

  // ---------------- 聊天 ----------------
  handle('chat:send-text', (peerId: string, text: string) => service.sendText(peerId, text))
  handle('chat:send-file-path', (peerId: string, filePath: string) => service.sendFile(peerId, filePath))
  handle('chat:pick-and-send', async (peerId: string) => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win!, {
      title: '选择要发送的文件',
      properties: ['openFile', 'multiSelections'],
    })
    if (result.canceled || result.filePaths.length === 0) return []
    const msgs = []
    for (const p of result.filePaths.slice(0, 20)) msgs.push(await service.sendFile(peerId, p))
    return msgs
  })
  handle('chat:retry', (peerId: string, id: string) => service.retry(peerId, id))
  handle('chat:clear', (peerId: string) => service.clearHistory(peerId))

  // ---------------- 下载 ----------------
  handle('download:start', (url: string, name: string, saveAs: boolean) => service.startDownload(url, name, saveAs))
  handle('download:cancel', (id: string) => service.cancelDownload(id))
  handle('download:reveal', (p: string) => service.revealPath(p))
  handle('download:open', (p: string) => service.openPath(p))

  // ---------------- 我的共享 ----------------
  handle('shares:add', () => service.addShare())
  handle('shares:remove', (id: string) => service.removeShare(id))
  handle('shares:toggle', (id: string, enabled: boolean) => service.toggleShare(id, enabled))
  handle('shares:rename', (id: string, name: string) => service.renameShare(id, name))
  handle('shares:reveal', (id: string) => service.revealShare(id))
  handle('shares:url', (id: string) => service.shareUrl(id))

  // ---------------- 邻居共享浏览 ----------------
  handle('peer:shares', (peerId: string) => service.peerShares(peerId))
  handle('peer:list', (peerId: string, shareId: string, relPath: string) => service.peerList(peerId, shareId, relPath))
  handle('peer:index', (peerId: string, shareId: string) => service.peerIndex(peerId, shareId))

  // ---------------- 本地模型根目录 ----------------
  handle('model:pick-file', async (): Promise<LocalRootInfo | null> => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win!, {
      title: '选择模型文件',
      properties: ['openFile'],
      filters: [
        { name: '三维模型', extensions: ['gltf', 'glb', 'obj', 'fbx', 'stl', 'ply', 'dae'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const info = roots.openRoot(path.dirname(result.filePaths[0]))
    // 将用户选中的文件置顶为第一候选
    const rel = path.relative(info.root, result.filePaths[0]).split(path.sep).join('/')
    info.candidates = [
      ...info.candidates.filter((c) => c.p === rel),
      ...info.candidates.filter((c) => c.p !== rel),
    ]
    if (!info.candidates.some((c) => c.p === rel)) {
      info.candidates.unshift({ p: rel, s: fs.statSync(result.filePaths[0]).size })
    }
    return info
  })

  handle('model:pick-folder', async (): Promise<LocalRootInfo | null> => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win!, {
      title: '选择模型所在文件夹',
      properties: ['openDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return roots.openRoot(result.filePaths[0])
  })

  handle('model:open-paths', (paths: string[]) => roots.openPaths(paths))
  handle('model:release-root', (token: string) => roots.release(token))

  // ---------------- 共享文件 -> 查看器数据源 ----------------
  handle('source:from-share', async (peerId: string, shareId: string, relPath: string, shareName: string): Promise<ViewerSource> => {
    const self = service.selfInfo()
    let baseUrl: string
    let originLabel: string
    if (peerId === self.id) {
      // 本机共享：经回环地址访问自己的 HTTP 服务
      if (!self.running || !self.port) throw new Error('本机共享服务未启动，请先开启局域网服务')
      if (!service.shares().some((s) => s.id === shareId && s.enabled)) throw new Error('共享不存在或已关闭')
      baseUrl = `http://127.0.0.1:${self.port}/share/${shareId}/fs/`
      originLabel = `本机共享「${shareName}」`
    } else {
      const peer = service.peers().find((p) => p.id === peerId)
      if (!peer) throw new Error('对方不在线')
      baseUrl = `http://${peer.ip}:${peer.port}/share/${shareId}/fs/`
      originLabel = `${peer.name} 的共享「${shareName}」`
    }
    let files: ViewerSource['files']
    let truncated = false
    try {
      const index = await service.peerIndex(peerId, shareId)
      files = index.files
      truncated = index.truncated
    } catch {
      // 索引失败不阻塞打开（相对路径仍可正常解析）
      files = undefined
    }
    return {
      kind: 'lan',
      baseUrl,
      relPath,
      name: path.posix.basename(relPath),
      files,
      truncated,
      originLabel,
    }
  })

  handle('source:from-local', (info: LocalRootInfo, relPath: string): ViewerSource => {
    return {
      kind: 'local',
      baseUrl: `intrabox://local/${info.token}/`,
      relPath,
      name: path.posix.basename(relPath),
      files: info.files,
      truncated: info.truncated,
      originLabel: `本地文件夹 ${info.root}`,
      root: info.root,
      localPath: path.join(info.root, relPath),
    }
  })
}