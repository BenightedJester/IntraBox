import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { PublicShare } from '../../src/shared/lan-types'
import { listDir, mimeOf, normalizeIp, safeJoin, walkFiles } from './fs-utils'

export interface OutgoingFile {
  path: string
  name: string
  size: number
  mime: string
}

export interface HttpDeps {
  getInfo(): { id: string; name: string; port: number; version: string }
  getShares(): PublicShare[]
  /** 仅返回启用中的共享根目录 */
  getShareRoot(id: string): string | null
  receiveChat(body: unknown, remoteIp: string): { ok: boolean; error?: string }
  getOutgoingFile(fileId: string): OutgoingFile | null
  /** 打包后的渲染端静态目录（生产模式经 http 加载，保证 Cesium Workers 同源） */
  appDir: string | null
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  'Access-Control-Max-Age': '86400',
}

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data)
  res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

/** 流式发送文件，支持 Range（大文件 / 瓦片按需加载必需） */
function streamFile(req: http.IncomingMessage, res: http.ServerResponse, filePath: string, downloadName?: string) {
  let st: fs.Stats
  try {
    st = fs.statSync(filePath)
  } catch {
    sendJson(res, 404, { error: '文件不存在' })
    return
  }
  if (!st.isFile()) {
    sendJson(res, 400, { error: '不是文件' })
    return
  }
  const headers: Record<string, string> = {
    ...CORS_HEADERS,
    'Content-Type': mimeOf(filePath),
    'Accept-Ranges': 'bytes',
    'Last-Modified': st.mtime.toUTCString(),
    'Cache-Control': 'no-cache',
  }
  if (downloadName) {
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`
  }

  const range = req.headers.range
  let start = 0
  let end = st.size - 1
  let status = 200
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (m) {
      if (m[1] === '' && m[2] !== '') {
        // suffix range: bytes=-N
        const n = parseInt(m[2], 10)
        start = Math.max(0, st.size - n)
      } else if (m[1] !== '') {
        start = parseInt(m[1], 10)
        if (m[2] !== '') end = Math.min(parseInt(m[2], 10), st.size - 1)
      }
      if (start > end || start >= st.size) {
        res.writeHead(416, { ...CORS_HEADERS, 'Content-Range': `bytes */${st.size}` })
        res.end()
        return
      }
      status = 206
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`
    }
  }
  headers['Content-Length'] = String(end - start + 1)
  res.writeHead(status, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = fs.createReadStream(filePath, { start, end })
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

function readJsonBody(req: http.IncomingMessage, limit = 2 * 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'))
      } catch {
        reject(new Error('JSON 解析失败'))
      }
    })
    req.on('error', reject)
  })
}

/** 解码 URL 路径段为原始相对路径 */
function decodeRelPath(segments: string[]): string {
  return segments
    .map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        return s
      }
    })
    .join('/')
}

export function createLanServer(deps: HttpDeps): http.Server {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[http] 处理请求失败', err)
      if (!res.headersSent) sendJson(res, 500, { error: String(err?.message ?? err) })
      else res.destroy()
    })
  })

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const parts = url.pathname.split('/').filter(Boolean)
    const method = req.method ?? 'GET'

    if (method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS)
      res.end()
      return
    }

    // ---- 基础信息 ----
    if (url.pathname === '/api/ping') {
      sendJson(res, 200, { ok: true, app: 'intrabox' })
      return
    }
    if (url.pathname === '/api/info' && method === 'GET') {
      sendJson(res, 200, { app: 'intrabox', ...deps.getInfo() })
      return
    }

    // ---- 聊天 ----
    if (url.pathname === '/api/chat/message' && method === 'POST') {
      try {
        const body = await readJsonBody(req)
        const result = deps.receiveChat(body, normalizeIp(req.socket.remoteAddress ?? ''))
        sendJson(res, result.ok ? 200 : 400, result)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String((err as Error).message) })
      }
      return
    }
    // 聊天文件：/api/chat/file/<fileId>[/<文件名>]。文件名尾缀仅供 URL 自描述
    // （查看器按扩展名识别格式），内容仍由 fileId 决定，下载名以登记名为准
    if (parts[0] === 'api' && parts[1] === 'chat' && parts[2] === 'file' && parts[3] && parts.length <= 5) {
      const file = deps.getOutgoingFile(parts[3])
      if (!file) {
        sendJson(res, 404, { error: '文件已失效（发送方可能已重启或取消）' })
        return
      }
      streamFile(req, res, file.path, file.name)
      return
    }

    // ---- 应用静态资源（生产模式）：/app/… ----
    if (parts[0] === 'app' && deps.appDir) {
      let rel = decodeRelPath(parts.slice(1))
      if (rel === '') rel = 'index.html'
      let abs = safeJoin(deps.appDir, rel)
      if (abs && fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
        abs = safeJoin(deps.appDir, path.posix.join(rel, 'index.html'))
      }
      if (!abs || !fs.existsSync(abs)) {
        sendJson(res, 404, { error: '资源不存在' })
        return
      }
      streamFile(req, res, abs)
      return
    }

    // ---- 共享文件夹 ----
    if (url.pathname === '/api/shares' && method === 'GET') {
      sendJson(res, 200, { shares: deps.getShares() })
      return
    }
    if (parts[0] === 'api' && parts[1] === 'shares' && parts[2]) {
      const shareId = parts[2]
      const root = deps.getShareRoot(shareId)
      if (!root) {
        sendJson(res, 404, { error: '共享不存在或已关闭' })
        return
      }
      if (parts[3] === 'list' && method === 'GET') {
        const rel = url.searchParams.get('path') ?? ''
        const listing = listDir(root, rel)
        if (!listing) {
          sendJson(res, 404, { error: '目录不存在' })
          return
        }
        sendJson(res, 200, { path: rel, ...listing })
        return
      }
      if (parts[3] === 'index' && method === 'GET') {
        sendJson(res, 200, walkFiles(root))
        return
      }
      sendJson(res, 404, { error: '未知接口' })
      return
    }

    // ---- 共享文件流：/share/:id/fs/<相对路径> ----
    // 路径段形式（而非查询参数）保证 gltf / 3d-tiles 的相对资源 URL 能自然解析
    if (parts[0] === 'share' && parts[1] && parts[2] === 'fs') {
      const root = deps.getShareRoot(parts[1])
      if (!root) {
        sendJson(res, 404, { error: '共享不存在或已关闭' })
        return
      }
      const rel = decodeRelPath(parts.slice(3))
      const abs = safeJoin(root, rel)
      if (!abs) {
        sendJson(res, 403, { error: '非法路径' })
        return
      }
      streamFile(req, res, abs)
      return
    }

    sendJson(res, 404, { error: '未知接口' })
  }

  return server
}

/** 优先使用首选端口，被占用时自动向后寻找（支持同机多开联调） */
export function listenWithRetry(server: http.Server, preferred: number, tries = 30): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = preferred
    let attempts = 0
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && attempts < tries) {
        attempts++
        port++
        server.listen(port, '0.0.0.0')
      } else {
        server.removeListener('error', onError)
        reject(err)
      }
    }
    server.on('error', onError)
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', onError)
      resolve((server.address() as AddressInfo).port)
    })
  })
}