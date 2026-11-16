/**
 * 双实例端到端联调（生产构建 + CDP 驱动）。
 * 前置：node scripts/gen-test-assets.mjs && node scripts/prep-profiles.mjs
 *       两个实例分别以 INTRABOX_PROFILE=a/b INTRABOX_DEBUG_PORT=9222/9223 启动
 * 用法：node scripts/e2e-test.mjs [--skip-restart]
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { connect, waitFor, sleep } from './cdp.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS = path.join(ROOT, 'test-assets')
const SHOTS = path.join(ROOT, 'test-shots')
fs.mkdirSync(SHOTS, { recursive: true })

const P = (...seg) => JSON.stringify(path.join(ASSETS, ...seg))
let failures = 0
let passes = 0
function check(name, cond, extra = '') {
  if (cond) {
    passes++
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.error(`  ✗ ${name} ${extra}`)
  }
}
function phase(name) {
  console.log(`\n=== ${name} ===`)
}
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

const A = await connect(9222)
const B = await connect(9223)

async function state(c) {
  return c.eval('window.api.lan.getState()')
}
async function nav(c, hash) {
  await c.eval(`location.hash = ${JSON.stringify(hash)}`)
  await sleep(700)
}
async function clickByText(c, selector, text) {
  return c.eval(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.includes(${JSON.stringify(text)}))
    if (!el) return false
    el.click()
    return true
  })()`)
}

try {
  // ---------------- 0. 就绪 ----------------
  phase('0. 应用就绪（生产模式 http 加载）')
  await waitFor(() => A.eval('!!window.api'), { label: 'A preload' })
  await waitFor(() => B.eval('!!window.api'), { label: 'B preload' })
  const hrefA = await A.eval('location.href')
  check('A 经本机 HTTP 加载', /http:\/\/127\.0\.0\.1:\d+\/app\/index\.html/.test(hrefA), hrefA)
  const sa = await state(A)
  const sb = await state(B)
  check('A 名称/端口', sa.self.name === '测试机A' && sa.self.port > 0, JSON.stringify(sa.self))
  check('B 名称/端口', sb.self.name === '测试机B' && sb.self.port > 0 && sb.self.port !== sa.self.port)
  const idA = sa.self.id, idB = sb.self.id
  const portA = sa.self.port, portB = sb.self.port

  // ---------------- 1. 发现 ----------------
  phase('1. 局域网互相发现')
  await waitFor(async () => (await state(A)).peers.some((p) => p.id === idB), { label: 'A 发现 B', timeout: 20000 })
  await waitFor(async () => (await state(B)).peers.some((p) => p.id === idA), { label: 'B 发现 A', timeout: 20000 })
  check('双向发现成功', true)

  // ---------------- 2. 首页 ----------------
  phase('2. 首页渲染')
  await nav(A, '#/')
  await waitFor(() => A.eval('document.querySelectorAll(".tool-card").length'), { label: '首页卡片' })
  const cards = await A.eval('document.querySelectorAll(".tool-card").length')
  check('5 张工具卡片', cards === 5, String(cards))
  const chipText = await A.eval('[...document.querySelectorAll(".status-chip")].map(c=>c.textContent.trim()).join("|")')
  check('状态条显示在线设备', chipText.includes('1 台设备在线'), chipText)
  await A.shot(path.join(SHOTS, '01-home.png'))

  // ---------------- 3. 聊天文本 ----------------
  phase('3. 聊天文本 A→B')
  await A.eval(`window.api.chat.sendText(${JSON.stringify(idB)}, '你好 B，我是 A')`)
  await waitFor(async () => (await state(B)).messages.some((m) => m.dir === 'in' && m.text === '你好 B，我是 A'), { label: 'B 收到文本' })
  check('B 收到文本消息', true)
  await nav(B, '#/chat')
  await sleep(500)
  await clickByText(B, '.peer-item', '测试机A')
  await sleep(500)
  const bubble = await B.eval('document.body.innerText.includes("你好 B，我是 A")')
  check('B 聊天页渲染消息气泡', bubble)
  await B.shot(path.join(SHOTS, '02-chat-b.png'))

  // ---------------- 4. 聊天文件 + 下载 ----------------
  phase('4. 聊天文件 B→A + 下载校验')
  await B.eval(`window.api.chat.sendFilePath(${JSON.stringify(idA)}, ${P('大文件测试.bin')})`)
  const fileMsg = await waitFor(async () => {
    const s = await state(A)
    return s.messages.find((m) => m.dir === 'in' && m.type === 'file' && m.file?.name === '大文件测试.bin')
  }, { label: 'A 收到文件消息' })
  check('文件消息含下载地址', !!fileMsg.file.url, JSON.stringify(fileMsg.file))
  await A.eval(`window.__dls = {}; window.api.on('download:progress', p => { window.__dls[p.id] = p }); 'ok'`)
  const dl = await A.eval(`window.api.download.start(${JSON.stringify(fileMsg.file.url)}, '大文件测试.bin', false)`)
  const done = await waitFor(() => A.eval(`window.__dls[${JSON.stringify(dl.id)}]?.state === 'done' ? window.__dls[${JSON.stringify(dl.id)}] : null`), { label: '下载完成', timeout: 30000 })
  check('下载完成', done.state === 'done')
  check('下载字节一致（2MB sha256）', sha256(done.path) === sha256(path.join(ASSETS, '大文件测试.bin')))
  await nav(A, '#/chat')
  await clickByText(A, '.peer-item', '测试机B')
  await sleep(600)
  check('下载托盘可见', await A.eval('!!document.querySelector(".download-tray")'))
  await A.shot(path.join(SHOTS, '03-chat-a-file.png'))

  // ---------------- 5. 离线失败 + 重发 ----------------
  phase('5. 离线发送失败 → 恢复后重发')
  await B.eval('window.api.lan.setRunning(false)')
  await sleep(800)
  await A.eval(`window.api.chat.sendText(${JSON.stringify(idB)}, '离线消息')`)
  const failedMsg = await waitFor(async () => {
    const s = await state(A)
    return s.messages.find((m) => m.dir === 'out' && m.text === '离线消息' && m.status === 'failed')
  }, { label: '发送失败状态', timeout: 20000 })
  check('离线时标记失败', !!failedMsg)
  await B.eval('window.api.lan.setRunning(true)')
  await waitFor(async () => (await state(A)).peers.some((p) => p.id === idB), { label: 'B 重新上线', timeout: 20000 })
  await A.eval(`window.api.chat.retry(${JSON.stringify(idB)}, ${JSON.stringify(failedMsg.id)})`)
  await waitFor(async () => (await state(B)).messages.some((m) => m.text === '离线消息'), { label: '重发送达', timeout: 20000 })
  check('重发成功送达', true)

  // ---------------- 6. 共享浏览 ----------------
  phase('6. 共享浏览 / 开关')
  const sharesOfA = await B.eval(`window.api.peer.shares(${JSON.stringify(idA)})`)
  check('B 看到 A 的共享', sharesOfA.some((s) => s.id === 's-a'), JSON.stringify(sharesOfA))
  const listing = await B.eval(`window.api.peer.list(${JSON.stringify(idA)}, 's-a', '')`)
  check('根目录列出中文文件夹', listing.entries.some((e) => e.name === '多文件模型' && e.dir))
  const index = await B.eval(`window.api.peer.index(${JSON.stringify(idA)}, 's-a')`)
  check('文件索引 ≥ 16 项', index.files.length >= 16, String(index.files.length))
  await A.eval(`window.api.shares.toggle('s-a', false)`)
  await sleep(400)
  const off = await B.eval(`window.api.peer.shares(${JSON.stringify(idA)})`)
  check('关闭共享后不可见', !off.some((s) => s.id === 's-a'))
  await A.eval(`window.api.shares.toggle('s-a', true)`)
  await nav(B, '#/share')
  await sleep(1200)
  await B.shot(path.join(SHOTS, '04-share-b.png'))

  // ---------------- 7. 模型查看器 ----------------
  phase('7. 模型查看器：本地多文件 / 各格式 / 局域网 / URL')
  await nav(A, '#/model-viewer')
  await waitFor(() => A.eval('!!window.__model && !!window.__model.scene'), { label: '模型查看器就绪' })

  async function openAndWait(expr, name, vertices, kind) {
    await A.eval(expr)
    const st = await waitFor(async () => {
      const ok = await A.eval(`window.__model.source && window.__model.source.name === ${JSON.stringify(name)} && window.__model.stats.vertices > 0 ${kind ? `&& window.__model.source.kind === ${JSON.stringify(kind)}` : ''} ? { s: window.__model.stats, m: window.__model.missing, src: window.__model.source } : null`)
      return ok
    }, { label: `加载 ${name}`, timeout: 30000 })
    if (vertices !== undefined) check(`${name} 顶点数 ${vertices}`, st.s.vertices === vertices, String(st.s.vertices))
    return st
  }

  let st = await openAndWait(`window.__model.openPaths([${P('多文件模型')}])`, '场景 主文件.gltf', 24)
  check('多文件 gltf 外部资源全部解析（missing=0）', st.m.length === 0, JSON.stringify(st.m))
  check('贴图已加载', st.s.textures >= 1, String(st.s.textures))
  await sleep(800)
  await A.shot(path.join(SHOTS, '05-model-gltf.png'))

  await openAndWait(`window.__model.openPaths([${P('单文件', '立方体.glb')}])`, '立方体.glb', 24)
  st = await openAndWait(`window.__model.openPaths([${P('单文件', '立方体.obj')}])`, '立方体.obj', 36)
  check('obj 外部 mtl+贴图解析', st.m.length === 0 && st.s.textures >= 1, JSON.stringify(st.m))
  await A.shot(path.join(SHOTS, '06-model-obj.png'))
  await openAndWait(`window.__model.openPaths([${P('单文件', '四面体.stl')}])`, '四面体.stl', 12)
  await openAndWait(`window.__model.openPaths([${P('单文件', '金字塔.ply')}])`, '金字塔.ply', 5)
  st = await openAndWait(`window.__model.openPaths([${P('单文件', '点云.ply')}])`, '点云.ply', 400)
  await A.shot(path.join(SHOTS, '07-model-points.png'))
  await openAndWait(`window.__model.openPaths([${P('单文件', '立方体.dae')}])`, '立方体.dae')

  // 局域网来源
  const lanSrc = await A.eval(`window.api.source.fromShare(${JSON.stringify(idB)}, 's-b', '多文件模型/场景 主文件.gltf', 'B 的模型库')`)
  st = await openAndWait(`window.__model.openSource(${JSON.stringify(lanSrc)})`, '场景 主文件.gltf', 24, 'lan')
  check('局域网来源 missing=0', st.m.length === 0 && st.src.kind === 'lan', JSON.stringify(st.m))
  await sleep(600)
  await A.shot(path.join(SHOTS, '08-model-lan.png'))

  // URL 直开（共享直链，自动反查索引）
  const urlSrc = { kind: 'url', baseUrl: `http://127.0.0.1:${portB}/share/s-b/fs/多文件模型/`, relPath: '场景 主文件.gltf', name: '场景 主文件.gltf', originLabel: 'URL 直开测试' }
  st = await openAndWait(`window.__model.openSource(${JSON.stringify(urlSrc)})`, '场景 主文件.gltf', 24, 'url')
  check('URL 直开 missing=0', st.m.length === 0 && st.src.kind === 'url')

  // 线框 / 自动旋转控件
  await A.eval('window.__model.scene.settings.wireframe = true')
  await sleep(500)
  await A.shot(path.join(SHOTS, '09-model-wireframe.png'))
  await A.eval('window.__model.scene.settings.wireframe = false')
  const camBefore = await A.eval('(() => { const p = window.__model.scene.camera.position; return [p.x, p.y, p.z] })()')
  await A.eval('window.__model.scene.settings.autoRotate = true')
  await sleep(1200)
  const camAfter = await A.eval('(() => { const p = window.__model.scene.camera.position; return [p.x, p.y, p.z] })()')
  check('自动旋转生效', JSON.stringify(camBefore) !== JSON.stringify(camAfter))
  await A.eval('window.__model.scene.settings.autoRotate = false')

  // ---------------- 7b. 模型历史 ----------------
  phase('7b. 模型历史：记录 / 重开 / 删除 / 抽屉 UI')
  const hist = await A.eval('window.__model.history')
  check('历史 ≥ 9 条', hist.length >= 9, String(hist.length))
  const kinds = new Set(hist.map((h) => h.kind))
  check('历史覆盖 local/lan/url', kinds.has('local') && kinds.has('lan') && kinds.has('url'), [...kinds].join(','))
  const localEntry = hist.find((h) => h.kind === 'local' && h.name === '场景 主文件.gltf')
  check('本地条目保存绝对路径', !!localEntry?.localPath && !!localEntry?.root, JSON.stringify(localEntry))
  await openAndWait(`window.__model.openHistory(${JSON.stringify(localEntry)})`, '场景 主文件.gltf', 24, 'local')
  check('历史重开（本地）成功', true)
  const before = hist.length
  await A.eval(`window.api.lan.removeHistory('model', ${JSON.stringify(hist[hist.length - 1].id)})`)
  // 直接调 IPC 删除时以主进程为准（渲染层 store 由 UI 操作同步）
  const after = await A.eval(`window.api.lan.history().then(h => h.model.length)`)
  check('单条删除生效', after === before - 1, `${before} -> ${after}`)
  // 抽屉 UI
  await clickByText(A, '.top-actions button', '历史')
  await waitFor(() => A.eval('document.querySelectorAll(".history-item").length > 0'), { label: '历史抽屉' })
  await A.shot(path.join(SHOTS, '10-model-history.png'))
  await A.eval('document.querySelector(".history-item").click()')
  await sleep(2500)
  check('抽屉点击重开', await A.eval('!!window.__model.source && window.__model.stats.vertices > 0'))

  // ---------------- 8. 3D Tiles ----------------
  phase('8. 3D Tiles：ECEF / 控件 / 局部坐标 / 历史')
  await nav(A, '#/tiles-viewer')
  await waitFor(() => A.eval('!!window.__tiles && !!window.__tiles.viewer'), { label: 'Cesium 就绪', timeout: 30000 })
  check('Cesium 初始化', true)

  const tilesLan = await A.eval(`window.api.source.fromShare(${JSON.stringify(idB)}, 's-b', 'tiles/北京园区/tileset.json', 'B 的模型库')`)
  await A.eval(`window.__tiles.openSource(${JSON.stringify(tilesLan)})`)
  await waitFor(() => A.eval('window.__tiles.source && window.__tiles.stats.loaded > 0 ? true : null'), { label: 'ECEF 瓦片加载', timeout: 40000 })
  check('ECEF 瓦片已加载', true)
  check('无失败瓦片', await A.eval('window.__tiles.failed === 0'))
  check('识别为地心坐标', await A.eval('window.__tiles.localMode === false'))
  await sleep(2600)
  await A.shot(path.join(SHOTS, '11-tiles-ecef.png'))

  // 控件：白模样式 / SSE / 自动环绕
  await A.eval('window.__tiles.settings.style = "white"')
  await sleep(900)
  await A.shot(path.join(SHOTS, '12-tiles-white.png'))
  await A.eval('window.__tiles.settings.style = "original"')
  await A.eval('window.__tiles.settings.sse = 2')
  await sleep(600)
  check('SSE 实时应用', await A.eval('window.__tiles.tileset.maximumScreenSpaceError === 2'))
  await A.eval('window.__tiles.settings.sse = 16')
  const tCamBefore = await A.eval('(() => { const p = window.__tiles.viewer.camera.positionWC; return [p.x, p.y, p.z] })()')
  await A.eval('window.__tiles.settings.autoRotate = true')
  await sleep(1500)
  const tCamAfter = await A.eval('(() => { const p = window.__tiles.viewer.camera.positionWC; return [p.x, p.y, p.z] })()')
  check('自动环绕生效', JSON.stringify(tCamBefore) !== JSON.stringify(tCamAfter))
  await A.eval('window.__tiles.settings.autoRotate = false')

  // 局部坐标 tileset（URL 直开）
  const localTiles = { kind: 'url', baseUrl: `http://127.0.0.1:${portB}/share/s-b/fs/tiles/局部模型/`, relPath: 'tileset.json', name: 'tileset.json', originLabel: '局部坐标测试' }
  await A.eval(`window.__tiles.openSource(${JSON.stringify(localTiles)})`)
  await waitFor(() => A.eval('window.__tiles.source && window.__tiles.localMode && window.__tiles.stats.loaded > 0 ? true : null'), { label: '局部瓦片加载', timeout: 40000 })
  check('局部坐标识别 + 地球隐藏', await A.eval('window.__tiles.viewer.scene.globe.show === false'))
  await sleep(1200)
  await A.shot(path.join(SHOTS, '13-tiles-local.png'))

  // 瓦片历史
  const tilesHistory = await A.eval('window.api.lan.history().then(h => h.tiles)')
  check('瓦片历史 ≥ 2 条', tilesHistory.length >= 2, String(tilesHistory.length))
  check('瓦片历史覆盖 lan/url', new Set(tilesHistory.map((h) => h.kind)).size >= 2)
  // 关闭 → 从历史抽屉重开
  await clickByText(A, '.panel__btns button', '关闭')
  await waitFor(() => A.eval('window.__tiles.source === null'), { label: '关闭瓦片' })
  await clickByText(A, '.top-actions button', '历史')
  await waitFor(() => A.eval('document.querySelectorAll(".history-item").length > 0'), { label: '瓦片历史抽屉' })
  await A.shot(path.join(SHOTS, '14-tiles-history.png'))
  await A.eval('document.querySelector(".history-item").click()')
  await waitFor(() => A.eval('window.__tiles.source && window.__tiles.stats.loaded > 0 ? true : null'), { label: '历史重开瓦片', timeout: 40000 })
  check('瓦片历史重开成功', true)

  // ---------------- 9. 二维码助手 ----------------
  phase('9. 二维码助手回归')
  await nav(A, '#/qr-helper')
  await waitFor(() => A.eval('!!document.querySelector("canvas, img")'), { label: '二维码页' })
  await sleep(600)
  await A.shot(path.join(SHOTS, '15-qr.png'))
  check('二维码页正常渲染', true)

  // ---------------- 10. 控制台审计 ----------------
  phase('10. 渲染进程控制台审计')
  const errA = A.consoleLogs.filter((l) => l.type === 'error')
  const errB = B.consoleLogs.filter((l) => l.type === 'error')
  check('A 无未捕获异常', A.exceptions.length === 0, A.exceptions.join(' | '))
  check('B 无未捕获异常', B.exceptions.length === 0, B.exceptions.join(' | '))
  if (errA.length) console.log('  A console.error:', JSON.stringify(errA.slice(0, 8), null, 1))
  if (errB.length) console.log('  B console.error:', JSON.stringify(errB.slice(0, 8), null, 1))
  check('A 无 console.error', errA.length === 0)
  check('B 无 console.error', errB.length === 0)

  fs.writeFileSync(path.join(SHOTS, 'pre-restart-history.json'), JSON.stringify(await A.eval('window.api.lan.history()'), null, 2))
} catch (err) {
  failures++
  console.error('\n!! 测试中断:', err.message)
  try { await A.shot(path.join(SHOTS, 'error-a.png')) } catch { /* ignore */ }
  try { await B.shot(path.join(SHOTS, 'error-b.png')) } catch { /* ignore */ }
} finally {
  console.log(`\n========== 结果：${passes} 通过 / ${failures} 失败 ==========`)
  A.close()
  B.close()
  process.exit(failures > 0 ? 1 : 0)
}