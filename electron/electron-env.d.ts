/// <reference types="vite-plugin-electron/electron-env" />

declare namespace NodeJS {
  interface ProcessEnv {
    /**
     * The built directory structure
     *
     * ```tree
     * ├─┬─┬ dist
     * │ │ └── index.html
     * │ │
     * │ ├─┬ dist-electron
     * │ │ ├── main.js
     * │ │ └── preload.js
     * │
     * ```
     */
    APP_ROOT: string
    /** /dist/ or /public/ */
    VITE_PUBLIC: string
  }
}

// Used in Renderer process, expose in `preload.ts`
// 使用内联 import() 类型，保持本文件为全局脚本（非模块）
type LanTypes = typeof import('../src/shared/lan-types')

interface Window {
  ipcRenderer: import('electron').IpcRenderer
  /** Cesium 静态资源基地址（main.ts 中按 document.baseURI 推导） */
  CESIUM_BASE_URL?: string
  api: {
    /** 打开文件对话框选择图片，返回 { name, dataUrl } 或 null */
    pickImage(): Promise<{ name: string; dataUrl: string } | null>
    /** 全屏截图，返回 dataURL 或 null */
    captureScreen(): Promise<string | null>
    /** 读取剪贴板图片，返回 dataURL 或 null */
    readClipboardImage(): Promise<string | null>
    /** 拖拽 File -> 本机绝对路径 */
    getPathForFile(file: File): string
    /** 订阅主进程事件，返回取消订阅函数 */
    on(channel: LanTypes['LAN_EVENTS'][number], listener: (...args: any[]) => void): () => void

    lan: {
      getState(): Promise<LanTypes['ChatState']>
      setName(name: string): Promise<LanTypes['SelfInfo']>
      setRunning(on: boolean): Promise<LanTypes['SelfInfo']>
      history(): Promise<LanTypes['HistoryLists']>
      pushHistory(kind: 'model' | 'tiles', entry: LanTypes['HistoryEntry']): Promise<void>
      removeHistory(kind: 'model' | 'tiles', id: string): Promise<void>
      clearHistory(kind: 'model' | 'tiles'): Promise<void>
    }
    chat: {
      sendText(peerId: string, text: string): Promise<LanTypes['ChatMessage']>
      sendFilePath(peerId: string, filePath: string): Promise<LanTypes['ChatMessage']>
      pickAndSend(peerId: string): Promise<LanTypes['ChatMessage'][]>
      retry(peerId: string, id: string): Promise<void>
      clear(peerId: string): Promise<void>
    }
    download: {
      start(url: string, name: string, saveAs: boolean): Promise<{ id: string } | null>
      cancel(id: string): Promise<void>
      reveal(p: string): Promise<void>
      open(p: string): Promise<void>
    }
    shares: {
      add(): Promise<LanTypes['ShareInfo'][] | null>
      remove(id: string): Promise<void>
      toggle(id: string, enabled: boolean): Promise<void>
      rename(id: string, name: string): Promise<void>
      reveal(id: string): Promise<void>
      url(id: string): Promise<string>
    }
    peer: {
      shares(peerId: string): Promise<LanTypes['PublicShare'][]>
      list(peerId: string, shareId: string, relPath: string): Promise<LanTypes['DirListing']>
      index(peerId: string, shareId: string): Promise<LanTypes['FileIndex']>
    }
    model: {
      pickFile(): Promise<LanTypes['LocalRootInfo'] | null>
      pickFolder(): Promise<LanTypes['LocalRootInfo'] | null>
      openPaths(paths: string[]): Promise<LanTypes['LocalRootInfo']>
      releaseRoot(token: string): Promise<void>
    }
    source: {
      fromShare(peerId: string, shareId: string, relPath: string, shareName: string): Promise<LanTypes['ViewerSource']>
      fromLocal(info: LanTypes['LocalRootInfo'], relPath: string): Promise<LanTypes['ViewerSource']>
    }
  }
}
