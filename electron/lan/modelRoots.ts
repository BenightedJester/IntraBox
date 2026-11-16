import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { net } from 'electron'
import { pathToFileURL } from 'node:url'
import type { LocalRootInfo } from '../../src/shared/lan-types'
import { isModelFile } from '../../src/shared/lan-types'
import { safeJoin, walkFiles } from './fs-utils'

interface RootEntry {
  root: string
  info: LocalRootInfo
}

/**
 * 本地模型根目录管理 + intrabox:// 协议。
 *
 * - intrabox://app/<path>        映射到应用静态资源（draco / basis 解码器等）
 * - intrabox://local/<token>/…   映射到用户打开的本地文件夹（仅本机可见，不进局域网共享）
 *
 * 使用标准 scheme（standard + supportFetchAPI），three.js 的相对资源
 * 解析、fetch、<img> 加载均可正常工作，且不受 file:// 的 fetch 限制。
 */
export class ModelRoots {
  private roots = new Map<string, RootEntry>()
  private assetDir: string

  constructor(assetDir: string) {
    this.assetDir = assetDir
  }

  /** 打开一个本地目录，建立索引并返回 token */
  openRoot(dir: string): LocalRootInfo {
    const root = path.resolve(dir)
    const st = fs.statSync(root)
    if (!st.isDirectory()) throw new Error('不是有效目录')
    // 同一目录复用 token
    for (const entry of this.roots.values()) {
      if (entry.root === root) return entry.info
    }
    const { files, truncated } = walkFiles(root)
    const token = randomUUID().slice(0, 12)
    const info: LocalRootInfo = {
      token,
      root,
      name: path.basename(root),
      files,
      truncated,
      candidates: files.filter((f) => isModelFile(f.p)).sort((a, b) => a.p.localeCompare(b.p, 'zh-CN')),
    }
    this.roots.set(token, { root, info })
    // 控制内存：最多保留 12 个根
    if (this.roots.size > 12) {
      const first = this.roots.keys().next().value
      if (first) this.roots.delete(first)
    }
    return info
  }

  /**
   * 拖入一组路径（文件 / 文件夹混合）：取公共父目录作为资源根，
   * 保证 gltf + bin + 贴图一起拖入时外部资源可解析。
   */
  openPaths(paths: string[]): LocalRootInfo {
    const valid = paths.filter((p) => fs.existsSync(p))
    if (valid.length === 0) throw new Error('拖入的路径不存在')
    const resolved = valid.map((p) => path.resolve(p))
    // 单个目录直接作为根
    if (resolved.length === 1 && fs.statSync(resolved[0]).isDirectory()) {
      return this.openRoot(resolved[0])
    }
    // 计算公共父目录
    const split = resolved.map((p) => p.split(path.sep))
    const common: string[] = []
    for (let i = 0; i < split[0].length; i++) {
      const seg = split[0][i]
      if (split.every((s) => s[i] === seg)) common.push(seg)
      else break
    }
    let rootDir = common.join(path.sep) || path.parse(resolved[0]).root
    // 公共路径本身是文件时取其父目录
    if (fs.existsSync(rootDir) && fs.statSync(rootDir).isFile()) {
      rootDir = path.dirname(rootDir)
    }
    const info = this.openRoot(rootDir)
    // 若拖入的是单个模型文件，把它排到候选首位
    if (resolved.length === 1 && isModelFile(resolved[0])) {
      const rel = path.relative(info.root, resolved[0]).split(path.sep).join('/')
      info.candidates = [
        ...info.candidates.filter((c) => c.p === rel),
        ...info.candidates.filter((c) => c.p !== rel),
      ]
    }
    return info
  }

  release(token: string) {
    this.roots.delete(token)
  }

  getRoot(token: string): string | null {
    return this.roots.get(token)?.root ?? null
  }

  /** protocol.handle('intrabox', …) 的处理器 */
  async handleProtocol(request: Request): Promise<Response> {
    const cors = { 'Access-Control-Allow-Origin': '*' }
    try {
      const url = new URL(request.url)
      let abs: string | null = null
      if (url.hostname === 'app') {
        abs = safeJoin(this.assetDir, decodeURIComponent(url.pathname))
      } else if (url.hostname === 'local') {
        const segments = url.pathname.split('/').filter(Boolean)
        const token = segments.shift() ?? ''
        const root = this.roots.get(token)?.root
        if (!root) return new Response('root not found', { status: 404, headers: cors })
        const rel = segments
          .map((s) => {
            try {
              return decodeURIComponent(s)
            } catch {
              return s
            }
          })
          .join('/')
        abs = safeJoin(root, rel)
      }
      if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        return new Response('not found', { status: 404, headers: cors })
      }
      const resp = await net.fetch(pathToFileURL(abs).toString())
      // 补上 CORS 头，保证 <img crossOrigin> / fetch 在任意源下可用
      const headers = new Headers(resp.headers)
      headers.set('Access-Control-Allow-Origin', '*')
      return new Response(resp.body, { status: resp.status, headers })
    } catch (err) {
      console.error('[protocol] intrabox 处理失败', err)
      return new Response('internal error', { status: 500, headers: cors })
    }
  }
}