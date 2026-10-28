import { app, BrowserWindow, ipcMain, dialog, desktopCapturer, clipboard, screen, Menu, type WebContents } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

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

let win: BrowserWindow | null

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
    icon: path.join(process.env.VITE_PUBLIC, 'electron-vite.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
    },
  })

  // Test active push message to Renderer-process.
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', (new Date).toLocaleString())
  })

  registerShortcuts(win.webContents)

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    // win.loadFile('dist/index.html')
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
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

app.whenReady().then(() => {
  // 移除原生应用菜单栏
  Menu.setApplicationMenu(null)
  createWindow()
})
