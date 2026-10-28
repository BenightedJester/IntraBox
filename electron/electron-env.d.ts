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
interface Window {
  ipcRenderer: import('electron').IpcRenderer
  api: {
    /** 打开文件对话框选择图片，返回 { name, dataUrl } 或 null */
    pickImage(): Promise<{ name: string; dataUrl: string } | null>
    /** 全屏截图，返回 dataURL 或 null */
    captureScreen(): Promise<string | null>
    /** 读取剪贴板图片，返回 dataURL 或 null */
    readClipboardImage(): Promise<string | null>
  }
}
