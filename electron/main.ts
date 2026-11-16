import { app, BrowserWindow, ipcMain, dialog, desktopCapturer, clipboard, screen, Menu, protocol, type WebContents } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { LanService } from './lan/service'
import { ModelRoots } from './lan/modelRoots'
import { registerLanIpc } from './ipc'
import { LAN_EVENTS } from '../src/shared/lan-types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, '..')

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

// --------- 调试 / 多实例支持 ---------
// INTRABOX_DEBUG_PORT：开启 Chrome 远程调试（自动化联调用）
// INTRABOX_PROFILE：隔离 userData，便于同机多开测试局域网功能
if (process.env.INTRABOX_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.INTRABOX_DEBUG_PORT)
}
// 局域网工具需要后台窗口持续刷新（消息/下载/渲染），同时避免 Windows 遮挡检测
// 导致后台窗口停止合成帧（CDP 截图会因此挂起）
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
if (process.env.INTRABOX_PROFILE) {
  app.setPath('userData', path.join(app.getPath('appData'), `intrabox-profile-${process.env.INTRABOX_PROFILE}`))
}

// intrabox:// 协议：本地模型资源 / 应用静态资源（解码器等）
// 必须在 app ready 之前注册为特权 scheme
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'intrabox',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
])

let win: BrowserWindow | null
let lanService: LanService | null = null
let modelRoots: ModelRoots | null = null

// 安全推送：退出流程中窗口可能已销毁，而服务 stop() 仍会派发事件
function sendToWindow(channel: string, payload?: unknown) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

// --------- 移除原生菜单栏后，补回常用快捷键 ---------
// 移除应用菜单会导致 Windows/Linux 下 Ctrl+C/V 等编辑快捷键失效，
// 而本应用依赖 Ctrl+V 粘贴图片，故在此手动接管。
function registerShortcuts(webContents: WebContents) {
  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const ctrl = input.control || input.meta
    if (!ctrl) return
    const key = input.key.toLowerCase()
    if (input.shift && key === 'i') {
      webContents.toggleDevTools()
      event.preventDefault()
      return
    }
    if (input.shift || input.alt) return
    switch (key) {
      case 'c':
        webContents.copy()
        event.preventDefault()
        break
      case 'x':
        webContents.cut()
        event.preventDefault()
        break
      case 'v':
        webContents.paste()
        event.preventDefault()
        break
      case 'a':
        webContents.selectAll()
        event.preventDefault()
        break
      case 'r':
        webContents.reload()
        event.preventDefault()
        break
    }
  })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    icon: path.join(process.env.VITE_PUBLIC, 'electron-vite.svg'),
    backgroundColor: '#f3f5fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      backgroundThrottling: false,
    },
  })

  win.webContents.on('did-finish-load', () => {
    sendToWindow('main-process-message', (new Date).toLocaleString())
  })

  // 窗口聚焦时停止任务栏闪烁
  win.on('focus', () => win?.flashFrame(false))

  registerShortcuts(win.webContents)

  if (VITE_DEV_SERVER_URL) {
    const url = process.env.INTRABOX_DEBUG_PORT
      ? VITE_DEV_SERVER_URL + (VITE_DEV_SERVER_URL.includes('?') ? '&' : '?') + 'debug=1'
      : VITE_DEV_SERVER_URL
    win.loadURL(url)
  } else {
    // 生产模式经本机 HTTP 服务加载：
    // Cesium 的 Worker / wasm 需要 http(s) 同源环境，file:// 无法满足
    const port = lanService?.selfInfo().port
    if (port) {
      const query = process.env.INTRABOX_DEBUG_PORT ? '?debug=1' : ''
      win.loadURL(`http://127.0.0.1:${port}/app/index.html${query}`)
    } else {
      win.loadFile(path.join(RENDERER_DIST, 'index.html'))
    }
  }
}

// --------- IPC: 选择图片文件 ---------
ipcMain.handle('dialog:pick-image', async () => {
  if (!win) return null
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '选择包含二维码的图片',
    properties: ['openFile'],
    filters: [
      { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] },
    ],
  })
  if (canceled || filePaths.length === 0) return null
  const filePath = filePaths[0]
  const dataUrl = `data:${mimeFromExt(filePath)};base64,${fs.readFileSync(filePath).toString('base64')}`
  return { name: path.basename(filePath), dataUrl }
})

// --------- IPC: 全屏截图 ---------
ipcMain.handle('screen:capture', async () => {
  const display = screen.getPrimaryDisplay()
  const { width, height } = display.size
  const scaleFactor = display.scaleFactor || 1
  // 隐藏窗口，等待其在屏幕上消失后再抓取
  win?.hide()
  await new Promise(resolve => setTimeout(resolve, 300))
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(width * scaleFactor),
        height: Math.round(height * scaleFactor),
      },
    })
    const source = sources.find(s => s.display_id === String(display.id)) ?? sources[0]
    if (!source) return null
    return source.thumbnail.toDataURL()
  } finally {
    win?.show()
    win?.focus()
  }
})

// --------- IPC: 读取剪贴板图片 ---------
ipcMain.handle('clipboard:read-image', () => {
  const image = clipboard.readImage()
  if (image.isEmpty()) return null
  return image.toDataURL()
})

function mimeFromExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().replace('.', '')
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    case 'gif':
      return 'image/gif'
    case 'bmp':
      return 'image/bmp'
    case 'webp':
      return 'image/webp'
    default:
      return 'image/png'
  }
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(async () => {
  // 移除原生应用菜单栏
  Menu.setApplicationMenu(null)

  // 本地模型根目录 + intrabox:// 协议
  modelRoots = new ModelRoots(process.env.VITE_PUBLIC!)
  protocol.handle('intrabox', (request) => modelRoots!.handleProtocol(request))

  // 局域网服务（发现 / HTTP / 聊天 / 共享 / 下载）
  lanService = new LanService(app.getPath('userData'), () => win, VITE_DEV_SERVER_URL ? null : RENDERER_DIST)
  for (const channel of LAN_EVENTS) {
    lanService.on(channel, (payload) => {
      sendToWindow(channel, payload)
    })
  }
  registerLanIpc(lanService, modelRoots, () => win)

  if (lanService.settings.data.serviceEnabled) {
    try {
      await lanService.start()
    } catch (err) {
      console.error('[lan] 服务启动失败', err)
    }
  }

  createWindow()
})

app.on('before-quit', () => {
  lanService?.settings.flush()
  void lanService?.stop()
})
