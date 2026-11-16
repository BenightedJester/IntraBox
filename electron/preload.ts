import { ipcRenderer, contextBridge, webUtils } from 'electron'
import { LAN_EVENTS, type LanEventChannel } from '../src/shared/lan-types'

// --------- Expose some API to the Renderer process ---------
contextBridge.exposeInMainWorld('ipcRenderer', {
  on(...args: Parameters<typeof ipcRenderer.on>) {
    const [channel, listener] = args
    return ipcRenderer.on(channel, (event, ...args) => listener(event, ...args))
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, ...omit] = args
    return ipcRenderer.off(channel, ...omit)
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args
    return ipcRenderer.send(channel, ...omit)
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args
    return ipcRenderer.invoke(channel, ...omit)
  },

  // You can expose other APTs you need here.
  // ...
})

// --------- 二维码助手相关 API ---------
contextBridge.exposeInMainWorld('api', {
  /** 打开文件对话框选择图片，返回 { name, dataUrl } 或 null */
  pickImage: (): Promise<{ name: string; dataUrl: string } | null> =>
    ipcRenderer.invoke('dialog:pick-image'),
  /** 全屏截图，返回 dataURL 或 null */
  captureScreen: (): Promise<string | null> =>
    ipcRenderer.invoke('screen:capture'),
  /** 读取剪贴板图片，返回 dataURL 或 null */
  readClipboardImage: (): Promise<string | null> =>
    ipcRenderer.invoke('clipboard:read-image'),

  /** 拖拽 File -> 本机绝对路径（Electron webUtils） */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  /** 订阅主进程事件（白名单通道），返回取消订阅函数 */
  on: (channel: LanEventChannel, listener: (...args: any[]) => void): (() => void) => {
    if (!(LAN_EVENTS as readonly string[]).includes(channel)) return () => {}
    const wrapped = (_event: unknown, ...args: any[]) => listener(...args)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.off(channel, wrapped)
    }
  },

  // ---- 局域网状态 / 设置 ----
  lan: {
    getState: () => ipcRenderer.invoke('lan:get-state'),
    setName: (name: string) => ipcRenderer.invoke('lan:set-name', name),
    setRunning: (on: boolean) => ipcRenderer.invoke('lan:set-running', on),
    history: () => ipcRenderer.invoke('lan:history'),
    pushHistory: (kind: 'model' | 'tiles', entry: unknown) => ipcRenderer.invoke('lan:push-history', kind, entry),
    removeHistory: (kind: 'model' | 'tiles', id: string) => ipcRenderer.invoke('lan:remove-history', kind, id),
    clearHistory: (kind: 'model' | 'tiles') => ipcRenderer.invoke('lan:clear-history', kind),
  },

  // ---- 聊天 ----
  chat: {
    sendText: (peerId: string, text: string) => ipcRenderer.invoke('chat:send-text', peerId, text),
    sendFilePath: (peerId: string, filePath: string) => ipcRenderer.invoke('chat:send-file-path', peerId, filePath),
    pickAndSend: (peerId: string) => ipcRenderer.invoke('chat:pick-and-send', peerId),
    retry: (peerId: string, id: string) => ipcRenderer.invoke('chat:retry', peerId, id),
    clear: (peerId: string) => ipcRenderer.invoke('chat:clear', peerId),
  },

  // ---- 下载 ----
  download: {
    start: (url: string, name: string, saveAs: boolean) => ipcRenderer.invoke('download:start', url, name, saveAs),
    cancel: (id: string) => ipcRenderer.invoke('download:cancel', id),
    reveal: (p: string) => ipcRenderer.invoke('download:reveal', p),
    open: (p: string) => ipcRenderer.invoke('download:open', p),
  },

  // ---- 我的共享 ----
  shares: {
    add: () => ipcRenderer.invoke('shares:add'),
    remove: (id: string) => ipcRenderer.invoke('shares:remove', id),
    toggle: (id: string, enabled: boolean) => ipcRenderer.invoke('shares:toggle', id, enabled),
    rename: (id: string, name: string) => ipcRenderer.invoke('shares:rename', id, name),
    reveal: (id: string) => ipcRenderer.invoke('shares:reveal', id),
    url: (id: string) => ipcRenderer.invoke('shares:url', id),
  },

  // ---- 邻居共享浏览 ----
  peer: {
    shares: (peerId: string) => ipcRenderer.invoke('peer:shares', peerId),
    list: (peerId: string, shareId: string, relPath: string) => ipcRenderer.invoke('peer:list', peerId, shareId, relPath),
    index: (peerId: string, shareId: string) => ipcRenderer.invoke('peer:index', peerId, shareId),
  },

  // ---- 本地模型根目录 ----
  model: {
    pickFile: () => ipcRenderer.invoke('model:pick-file'),
    pickFolder: () => ipcRenderer.invoke('model:pick-folder'),
    openPaths: (paths: string[]) => ipcRenderer.invoke('model:open-paths', paths),
    releaseRoot: (token: string) => ipcRenderer.invoke('model:release-root', token),
  },

  // ---- 查看器数据源 ----
  source: {
    fromShare: (peerId: string, shareId: string, relPath: string, shareName: string) =>
      ipcRenderer.invoke('source:from-share', peerId, shareId, relPath, shareName),
    fromLocal: (info: unknown, relPath: string) => ipcRenderer.invoke('source:from-local', info, relPath),
  },
})
