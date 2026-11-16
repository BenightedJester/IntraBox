/**
 * 重启持久化验证：
 * 1. 优雅关闭实例 A（触发 before-quit 落盘）
 * 2. 以同一 profile 重启 A
 * 3. 校验历史列表与重启前快照一致（含 id）
 * 4. 跨重启重开：本地模型历史条目（token 已失效，需按绝对路径重新定根）
 * 5. 跨重启重开：3D Tiles URL 历史条目
 * 前置：e2e-test.mjs 已跑通并生成 test-shots/pre-restart-history.json，B 实例仍在运行
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { connect, waitFor, sleep } from './cdp.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = path.join(ROOT, 'test-shots')
let failures = 0, passes = 0
function check(name, cond, extra = '') {
  if (cond) { passes++; console.log(`  ✓ ${name}`) }
  else { failures++; console.error(`  ✗ ${name} ${extra}`) }
}

const pre = JSON.parse(fs.readFileSync(path.join(SHOTS, 'pre-restart-history.json'), 'utf-8'))

console.log('=== R1. 重启前状态一致性 ===')
const A = await connect(9222)
const cur = await A.eval('window.api.lan.history()')
check('模型历史与快照一致', JSON.stringify(cur.model) === JSON.stringify(pre.model), `${cur.model.length} vs ${pre.model.length}`)
check('瓦片历史与快照一致', JSON.stringify(cur.tiles) === JSON.stringify(pre.tiles), `${cur.tiles.length} vs ${pre.tiles.length}`)

console.log('=== R2. 优雅关闭 A ===')
try { await A.send('Browser.close', {}, { timeout: 5000 }) } catch { /* 连接随关闭断开 */ }
A.close()
await waitFor(async () => {
  try { await fetch('http://127.0.0.1:9222/json', { signal: AbortSignal.timeout(1500) }); return null }
  catch { return true }
}, { label: 'A 进程退出', timeout: 20000 })
check('A 已退出', true)
await sleep(800)

console.log('=== R3. 重启 A（同 profile） ===')
const child = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.'], {
  cwd: ROOT,
  env: { ...process.env, INTRABOX_PROFILE: 'a', INTRABOX_DEBUG_PORT: '9222' },
  detached: true,
  stdio: 'ignore',
})
child.unref()
const A2 = await connect(9222, { timeout: 40000 })
await waitFor(() => A2.eval('!!window.api'), { label: 'A2 preload' })
check('A 重启成功', true)

console.log('=== R4. 历史持久化校验 ===')
const post = await A2.eval('window.api.lan.history()')
check('模型历史条数一致', post.model.length === pre.model.length, `${post.model.length} vs ${pre.model.length}`)
check('瓦片历史条数一致', post.tiles.length === pre.tiles.length, `${post.tiles.length} vs ${pre.tiles.length}`)
const idsPre = pre.model.map(e => e.id).join(',')
const idsPost = post.model.map(e => e.id).join(',')
check('模型历史 id/顺序完全一致（含去重后的稳定 id）', idsPre === idsPost)
check('本地条目绝对路径仍在', post.model.some(e => e.kind === 'local' && e.localPath && e.root))
const storeHydrated = await A2.eval('window.api.lan.getState().then(() => "ok")')
check('服务状态可用', storeHydrated === 'ok')

console.log('=== R5. 跨重启重开本地模型历史 ===')
await A2.eval(`location.hash = '#/model-viewer'`)
await waitFor(() => A2.eval('!!window.__model && !!window.__model.scene'), { label: '模型查看器就绪', timeout: 30000 })
const localEntry = pre.model.find(e => e.kind === 'local' && e.name === '场景 主文件.gltf')
await A2.eval(`window.__model.openHistory(${JSON.stringify(localEntry)})`)
const mst = await waitFor(() => A2.eval(`window.__model.source && window.__model.source.kind === 'local' && window.__model.stats.vertices > 0 ? { s: window.__model.stats, m: window.__model.missing } : null`), { label: '重启后本地历史重开', timeout: 30000 })
check('本地历史重开：顶点数 24', mst.s.vertices === 24, String(mst.s.vertices))
check('本地历史重开：外部资源无缺失', mst.m.length === 0, JSON.stringify(mst.m))
check('本地历史重开：贴图加载', mst.s.textures >= 1)
await sleep(800)
await A2.shot(path.join(SHOTS, '16-restart-model.png'))

console.log('=== R6. 跨重启重开瓦片历史（URL） ===')
await A2.eval(`location.hash = '#/tiles-viewer'`)
await waitFor(() => A2.eval('!!window.__tiles && !!window.__tiles.viewer'), { label: 'Cesium 就绪', timeout: 30000 })
const tilesEntry = pre.tiles.find(e => e.kind === 'url') ?? pre.tiles[0]
await A2.eval(`window.__tiles.openHistory(${JSON.stringify(tilesEntry)})`)
await waitFor(() => A2.eval('window.__tiles.source && window.__tiles.stats.loaded > 0 ? true : null'), { label: '重启后瓦片历史重开', timeout: 40000 })
check('瓦片历史重开成功', true)
check('无失败瓦片', await A2.eval('window.__tiles.failed === 0'))
await sleep(1500)
await A2.shot(path.join(SHOTS, '17-restart-tiles.png'))

console.log('=== R7. 重启后控制台审计 ===')
check('A2 无未捕获异常', A2.exceptions.length === 0, A2.exceptions.join(' | ').slice(0, 300))
const errs = A2.consoleLogs.filter(l => l.type === 'error')
check('A2 无 console.error', errs.length === 0, errs.map(e => e.text).join(' | ').slice(0, 300))

console.log(`\n========== 重启持久化：${passes} 通过 / ${failures} 失败 ==========`)
A2.close()
process.exit(failures > 0 ? 1 : 0)