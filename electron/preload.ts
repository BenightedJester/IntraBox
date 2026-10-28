import { ipcRenderer, contextBridge } from 'electron'

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
})
