import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import type { FileEntry, IndexFile } from '../../src/shared/lan-types'

/** 枚举本机非回环 IPv4 地址 */
export function lanIPv4s(): string[] {
  const result: string[] = []
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] ?? []) {
      if (info.family === 'IPv4' && !info.internal) result.push(info.address)
    }
  }
  return result
}

/**
 * 将相对路径安全地拼接到根目录内，防止路径穿越。
 * rel 为已解码的 posix 风格相对路径；返回 null 表示越界。
 */
export function safeJoin(root: string, rel: string): string | null {
  if (rel.includes('\0')) return null
  const normalized = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  const target = path.resolve(root, normalized)
  const rootResolved = path.resolve(root)
  if (target === rootResolved) return target
  if (!target.startsWith(rootResolved + path.sep)) return null
  return target
}

/** 将绝对路径转为相对 root 的 posix 路径 */
export function toPosixRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/')
}

const SKIP_DIRS = new Set(['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information'])

export interface WalkResult {
  files: IndexFile[]
  truncated: boolean
}

/**
 * 递归扫描目录，建立文件索引（用于外部资源容错解析）。
 * 限制文件数量与深度，避免超大目录拖垮进程。
 */
export function walkFiles(root: string, maxFiles = 20000, maxDepth = 10): WalkResult {
  const files: IndexFile[] = []
  let truncated = false
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  while (stack.length) {
    const { dir, depth } = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      if (files.length >= maxFiles) {
        truncated = true
        return { files, truncated }
      }
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(ent.name) && !ent.name.startsWith('.')) {
          stack.push({ dir: abs, depth: depth + 1 })
        }
      } else if (ent.isFile()) {
        try {
          const st = fs.statSync(abs)
          files.push({ p: toPosixRel(root, abs), s: st.size })
        } catch {
          /* 忽略无权限文件 */
        }
      }
    }
  }
  return { files, truncated }
}

/** 列出单层目录内容 */
export function listDir(root: string, rel: string, maxEntries = 5000): { entries: FileEntry[]; truncated: boolean } | null {
  const abs = safeJoin(root, rel)
  if (!abs) return null
  let dirents: fs.Dirent[]
  try {
    dirents = fs.readdirSync(abs, { withFileTypes: true })
  } catch {
    return null
  }
  const entries: FileEntry[] = []
  let truncated = false
  for (const ent of dirents) {
    if (entries.length >= maxEntries) {
      truncated = true
      break
    }
    const full = path.join(abs, ent.name)
    try {
      const st = fs.statSync(full)
      entries.push({
        name: ent.name,
        dir: st.isDirectory(),
        size: st.isDirectory() ? 0 : st.size,
        mtime: st.mtimeMs,
      })
    } catch {
      /* 忽略 */
    }
  }
  entries.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
  return { entries, truncated }
}

const MIME_MAP: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ktx2: 'image/ktx2',
  basis: 'image/basis',
  wasm: 'application/wasm',
  gltf: 'model/gltf+json',
  glb: 'model/gltf-binary',
  b3dm: 'application/octet-stream',
  i3dm: 'application/octet-stream',
  pnts: 'application/octet-stream',
  cmpt: 'application/octet-stream',
  bin: 'application/octet-stream',
  obj: 'text/plain; charset=utf-8',
  mtl: 'text/plain; charset=utf-8',
  fbx: 'application/octet-stream',
  stl: 'model/stl',
  ply: 'application/octet-stream',
  dae: 'model/vnd.collada+xml',
  txt: 'text/plain; charset=utf-8',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  zip: 'application/zip',
}

export function mimeOf(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().replace('.', '')
  return MIME_MAP[ext] ?? 'application/octet-stream'
}

/** ::ffff:127.0.0.1 -> 127.0.0.1 */
export function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip
}