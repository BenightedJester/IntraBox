import { defineConfig, type Plugin } from 'vite'
import path from 'node:path'
import fs from 'node:fs'
import electron from 'vite-plugin-electron/simple'
import vue from '@vitejs/plugin-vue'

/**
 * Cesium 静态资源（Workers / Assets / ThirdParty / Widgets）：
 * - 开发模式：以 /cesium 中间件直接从 node_modules 提供
 * - 构建模式：拷贝到 dist/cesium，随应用一起打包（离线可用）
 * 运行时通过 document.baseURI 推导 CESIUM_BASE_URL，开发 / 生产通用。
 */
function cesiumAssets(): Plugin {
  const source = path.join(__dirname, 'node_modules/cesium/Build/Cesium')
  const staticDirs = ['Workers', 'Assets', 'ThirdParty', 'Widgets']
  let outDir = ''
  const mime: Record<string, string> = {
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.glsl': 'text/plain; charset=utf-8',
  }
  return {
    name: 'intrabox-cesium-assets',
    configResolved(cfg) {
      outDir = cfg.build.outDir
    },
    configureServer(server) {
      server.middlewares.use('/cesium', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '')
        const abs = path.resolve(source, rel)
        if (!abs.startsWith(source) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          return next()
        }
        res.setHeader('Content-Type', mime[path.extname(abs).toLowerCase()] ?? 'application/octet-stream')
        res.setHeader('Cache-Control', 'no-cache')
        fs.createReadStream(abs).pipe(res)
      })
    },
    closeBundle() {
      // 仅在渲染端构建（outDir 为 dist）时拷贝，避免 electron 子构建重复执行
      if (path.basename(outDir) !== 'dist') return
      const target = path.join(outDir, 'cesium')
      for (const dir of staticDirs) {
        fs.cpSync(path.join(source, dir), path.join(target, dir), { recursive: true })
      }
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  // 生产模式经 http://127.0.0.1:<port>/app/ 加载，相对 base 保证资源路径正确
  base: './',
  plugins: [
    vue(),
    cesiumAssets(),
    electron({
      main: {
        // Shortcut of `build.lib.entry`.
        entry: 'electron/main.ts',
      },
      preload: {
        // Shortcut of `build.rollupOptions.input`.
        // Preload scripts may contain Web assets, so use the `build.rollupOptions.input` instead `build.lib.entry`.
        input: path.join(__dirname, 'electron/preload.ts'),
      },
      // Ployfill the Electron and Node.js API for Renderer process.
      // If you want use Node.js in Renderer process, the `nodeIntegration` needs to be enabled in the Main process.
      // See 👉 https://github.com/electron-vite/vite-plugin-electron-renderer
      renderer: process.env.NODE_ENV === 'test'
        // https://github.com/electron-vite/vite-plugin-electron-renderer/issues/78#issuecomment-2053600808
        ? undefined
        : {},
    }),
  ],
  build: {
    chunkSizeWarningLimit: 4000,
  },
})
