/** 设置功能冒烟：关闭行为 / 开机自启 IPC、持久化、设置页渲染、关闭拦截链路
 * 用法：先以 INTRABOX_DEBUG_PORT=9224 INTRABOX_PROFILE=<name> pnpm dev 启动隔离实例，
 * 再在相同 INTRABOX_PROFILE 下运行 node scripts/settings-smoke.mjs（两侧 profile 必须一致）。
 * 依赖 wm-close.ps1 模拟点 X；结束时会真正退出被测实例。 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { connect, waitFor, sleep } from './cdp.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
// 模拟用户点标题栏 X（渲染端 window.close() 在 Windows 上不经过 close 事件，不能用来验证）
const clickX = () => execFileSync('powershell', ['-NoProfile', '-File', path.join(ROOT, 'scripts', 'wm-close.ps1')])
let failures = 0, passes = 0
const check = (name, cond, extra = '') => {
  if (cond) { passes++; console.log(`  ✓ ${name}`) }
  else { failures++; console.error(`  ✗ ${name} ${extra}`) }
}

const C = await connect(9224, { timeout: 60000 })
await waitFor(() => C.eval('!!window.api && !!window.api.settings'), { label: 'settings api', timeout: 30000 })

// 默认值
const s0 = await C.eval('window.api.settings.get()')
check('默认关闭行为 = 每次询问', s0.closeAction === 'ask', JSON.stringify(s0))
check('默认开机自启 = 关闭', s0.autoStart === false)
check('开发模式自启不可用', s0.autoStartSupported === false)

// 修改关闭行为并验证持久化（隔离 profile）
await C.eval(`window.api.settings.setCloseAction('hide')`)
const s1 = await C.eval('window.api.settings.get()')
check('关闭行为可改为隐藏到托盘', s1.closeAction === 'hide')
await sleep(600) // 等待延迟落盘
const file = path.join(process.env.APPDATA, `intrabox-profile-${process.env.INTRABOX_PROFILE || 'settings-test'}`, 'intrabox.json')
const persisted = JSON.parse(fs.readFileSync(file, 'utf-8'))
check('关闭行为已持久化', persisted.closeAction === 'hide', JSON.stringify(persisted))

// 开发模式下自启应被拒绝
const err = await C.eval(`window.api.settings.setAutoStart(true).then(() => null, e => String(e.message || e))`)
check('开发模式开启自启被拒绝', typeof err === 'string' && err.includes('开发模式'), String(err))

// 设置页渲染
await C.eval(`location.hash = '#/settings'`)
await waitFor(() => C.eval(`document.body.innerText.includes('关闭主窗口时') && document.body.innerText.includes('开机自启')`), { label: '设置页', timeout: 15000 })
check('设置页渲染两项设置', true)
const radioChecked = await C.eval(`document.querySelector('.el-radio-group .is-checked')?.innerText?.trim()`)
check('设置页回显当前关闭行为', radioChecked === '隐藏到托盘', String(radioChecked))
const switchDisabled = await C.eval(`!!document.querySelector('.el-switch.is-disabled')`)
check('开发模式自启开关禁用', switchDisabled)
await C.shot(path.join(ROOT, 'test-shots', '19-settings.png'))

// 隐藏到托盘分支：点 X 后应用仍存活（窗口隐藏而非退出）
await C.eval(`window.api.settings.setCloseAction('hide')`)
await sleep(300)
clickX()
await sleep(1500)
let alive = false
try {
  const list = await fetch('http://127.0.0.1:9224/json', { signal: AbortSignal.timeout(2000) }).then(r => r.json())
  alive = list.some(t => t.type === 'page')
} catch { /* 已退出 */ }
check('隐藏设置下关闭仅隐藏不退出', alive)

// 改为直接退出后点 X 应真正退出（验证 close 拦截的 quit 分支）
await C.eval(`window.api.settings.setCloseAction('quit')`)
await sleep(300)
clickX()
await sleep(2500)
let gone = false
try {
  await fetch('http://127.0.0.1:9224/json', { signal: AbortSignal.timeout(1500) })
} catch {
  gone = true
}
check('直接退出设置下关闭即退出应用', gone)

console.log(`\n========== 设置功能冒烟：${passes} 通过 / ${failures} 失败 ==========`)
C.close()
process.exit(failures > 0 ? 1 : 0)