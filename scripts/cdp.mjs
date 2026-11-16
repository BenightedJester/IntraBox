/**
 * 极简 CDP 客户端（Node 全局 WebSocket / fetch）。
 * 用法：const c = await connect(9222); await c.eval('1+1'); await c.shot('a.png')
 */
import fs from 'node:fs'

export async function connect(port, { timeout = 30000 } = {}) {
  const start = Date.now()
  let target
  while (Date.now() - start < timeout) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (target) break
    } catch { /* 尚未就绪 */ }
    await sleep(400)
  }
  if (!target) throw new Error(`CDP 端口 ${port} 无页面目标`)

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('CDP WebSocket 连接失败'))
  })

  let seq = 0
  const pending = new Map()
  const consoleLogs = []
  const exceptions = []
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ')
      consoleLogs.push({ type: msg.params.type, text })
    } else if (msg.method === 'Runtime.exceptionThrown') {
      exceptions.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || 'unknown')
    }
  }

  function send(method, params = {}, { timeout = 30000 } = {}) {
    const id = ++seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP ${method} 超时（${timeout}ms）`))
      }, timeout)
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  await send('Runtime.enable')
  await send('Page.enable')

  return {
    send,
    consoleLogs,
    exceptions,
    async eval(expression, { awaitPromise = true } = {}) {
      const r = await send('Runtime.evaluate', {
        expression,
        returnByValue: false,
        awaitPromise,
      })
      if (r.exceptionDetails) {
        throw new Error('页面执行异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
      }
      const res = r.result
      if (res.objectId && res.type === 'object') {
        // Vue reactive 代理等对象无法被 returnByValue 直接深序列化（会得到空对象），
        // 改为在页面内 JSON.stringify 后回传解析
        const s = await send('Runtime.callFunctionOn', {
          objectId: res.objectId,
          functionDeclaration: 'function () { return JSON.stringify(this) }',
          returnByValue: true,
        })
        await send('Runtime.releaseObject', { objectId: res.objectId }).catch(() => {})
        if (s.exceptionDetails) {
          throw new Error('页面序列化异常: ' + (s.exceptionDetails.exception?.description || s.exceptionDetails.text))
        }
        const text = s.result?.value
        return text === undefined ? undefined : JSON.parse(text)
      }
      return res.value
    },
    async shot(file) {
      // Windows 下被遮挡/后台窗口会停止合成帧，captureScreenshot 可能永久挂起：
      // 先前置窗口，再带超时截图，失败重试一次
      await send('Page.bringToFront').catch(() => {})
      await sleep(400)
      let r
      try {
        r = await send('Page.captureScreenshot', { format: 'png' }, { timeout: 15000 })
      } catch {
        await send('Page.bringToFront').catch(() => {})
        await sleep(800)
        r = await send('Page.captureScreenshot', { format: 'png' }, { timeout: 15000 })
      }
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
      return file
    },
    close() {
      ws.close()
    },
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

export async function waitFor(fn, { timeout = 20000, interval = 400, label = '条件' } = {}) {
  const start = Date.now()
  let lastErr
  while (Date.now() - start < timeout) {
    try {
      const v = await fn()
      if (v) return v
    } catch (err) {
      lastErr = err
    }
    await sleep(interval)
  }
  throw new Error(`等待超时（${label}）${lastErr ? '：' + lastErr.message : ''}`)
}