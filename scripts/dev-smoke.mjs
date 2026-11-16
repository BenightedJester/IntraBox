/** 开发模式冒烟：Cesium worker 经 /cesium 中间件、解码器经 public/、本地模型加载 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, waitFor, sleep } from './cdp.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0, passes = 0
const check = (name, cond, extra = '') => {
  if (cond) { passes++; console.log(`  ✓ ${name}`) }
  else { failures++; console.error(`  ✗ ${name} ${extra}`) }
}

const C = await connect(9224, { timeout: 60000 })
await waitFor(() => C.eval('!!window.api'), { label: 'preload', timeout: 30000 })
check('开发模式 preload 就绪', true)
check('经 vite dev server 加载', /localhost:|127\.0\.0\.1:517/.test(await C.eval('location.href')), await C.eval('location.href'))

await C.eval(`location.hash = '#/tiles-viewer'`)
await waitFor(() => C.eval('!!window.__tiles && !!window.__tiles.viewer'), { label: 'Cesium(dev)', timeout: 40000 })
check('Cesium 初始化（dev /cesium 中间件）', true)
await sleep(1500)
check('worker/资源无报错', C.exceptions.length === 0, C.exceptions.join('|').slice(0, 200))

await C.eval(`location.hash = '#/model-viewer'`)
await waitFor(() => C.eval('!!window.__model && !!window.__model.scene'), { label: '模型查看器(dev)', timeout: 30000 })
await C.eval(`window.__model.openPaths([${JSON.stringify(path.join(ROOT, 'test-assets', '多文件模型'))}])`)
const st = await waitFor(() => C.eval(`window.__model.stats.vertices > 0 ? { s: window.__model.stats, m: window.__model.missing } : null`), { label: 'dev 本地模型', timeout: 30000 })
check('dev 本地多文件模型加载', st.s.vertices === 24 && st.m.length === 0, JSON.stringify(st))
await sleep(600)
await C.shot(path.join(ROOT, 'test-shots', '18-dev-model.png'))

const errs = C.consoleLogs.filter(l => l.type === 'error')
check('dev 无 console.error', errs.length === 0, errs.map(e => e.text).join('|').slice(0, 300))
console.log(`\n========== 开发模式冒烟：${passes} 通过 / ${failures} 失败 ==========`)
C.close()
process.exit(failures > 0 ? 1 : 0)