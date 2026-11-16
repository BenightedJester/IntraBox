import type { HistoryEntry, ViewerSource } from '../shared/lan-types'

/** 将相对路径逐段编码为 URL 路径（保留 '/'，安全处理中文 / 空格 / # / ?） */
export function encodeRelPath(rel: string): string {
  return rel
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/')
}

/** 数据源入口文件的完整 URL */
export function sourceEntryUrl(source: ViewerSource): string {
  return source.baseUrl + encodeRelPath(source.relPath)
}

/** 入口文件所在目录 URL（以 '/' 结尾），供加载器 setPath 使用 */
export function sourceDirUrl(source: ViewerSource): string {
  const i = source.relPath.lastIndexOf('/')
  const dir = i >= 0 ? source.relPath.slice(0, i + 1) : ''
  return source.baseUrl + encodeRelPath(dir)
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** 规范化相对路径：反斜杠转正斜杠、解析 . / ..、去掉前导 '/' */
function normalizeRel(rel: string): string {
  const parts = rel.replace(/\\/g, '/').split('/')
  const out: string[] = []
  for (const p of parts) {
    if (p === '' || p === '.') continue
    if (p === '..') out.pop()
    else out.push(p)
  }
  return out.join('/')
}

/**
 * 外部资源解析器。
 *
 * 多文件模型（gltf + bin + 贴图、obj + mtl、fbx 外置贴图）经常引用
 * 相对路径、绝对路径、反斜杠路径或大小写不一致的资源名。这里结合
 * 打开目录时建立的文件索引，做容错映射：
 *   1. 相对 baseUrl 的精确路径（忽略大小写）
 *   2. 按文件名（basename）在索引中回退查找
 * 无法解析的资源记录到 missing，供界面提示。
 */
export class ResourceResolver {
  readonly base: string
  private byPath = new Map<string, string>()
  private byName = new Map<string, string>()
  private missingSet = new Set<string>()
  /** 索引是否可用（URL 直开且无索引时为 false，仅做规范化） */
  readonly hasIndex: boolean

  constructor(source: ViewerSource) {
    this.base = source.baseUrl
    const files = source.files ?? []
    this.hasIndex = files.length > 0
    for (const f of files) {
      const lower = f.p.toLowerCase()
      if (!this.byPath.has(lower)) this.byPath.set(lower, f.p)
      const name = lower.slice(lower.lastIndexOf('/') + 1)
      const prev = this.byName.get(name)
      // 同名文件优先保留层级更浅的
      if (!prev || f.p.split('/').length < prev.split('/').length) {
        this.byName.set(name, f.p)
      }
    }
  }

  get missing(): string[] {
    return [...this.missingSet]
  }

  markMissing(url: string) {
    this.missingSet.add(url)
  }

  /** 供 LoadingManager.setURLModifier 使用 */
  resolve = (rawUrl: string): string => {
    if (!rawUrl) return rawUrl
    if (rawUrl.startsWith('data:') || rawUrl.startsWith('blob:')) return rawUrl

    let url = rawUrl.replace(/\\/g, '/')
    // 分离 query / hash（瓦片或签名 URL 可能携带）
    let suffix = ''
    const qIdx = url.search(/[?#]/)
    if (qIdx >= 0) {
      suffix = url.slice(qIdx)
      url = url.slice(0, qIdx)
    }

    // 其它绝对协议（http(s) 外链、intrabox 等）原样保留
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith(this.base)) {
      return rawUrl
    }

    let rel: string
    if (url.startsWith(this.base)) {
      rel = safeDecode(url.slice(this.base.length))
    } else if (/^[a-z]:\//i.test(url) || url.startsWith('/')) {
      // 绝对文件系统路径（常见于 fbx）：先按完整路径试，再退化为文件名
      rel = safeDecode(url)
    } else {
      rel = safeDecode(url)
    }
    rel = normalizeRel(rel)

    if (this.hasIndex) {
      const exact = this.byPath.get(rel.toLowerCase())
      if (exact) return this.base + encodeRelPath(exact) + suffix
      const name = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase()
      const byName = this.byName.get(name)
      if (byName) return this.base + encodeRelPath(byName) + suffix
      // 索引存在却找不到 -> 记录缺失
      if (rel) this.missingSet.add(rel)
    }

    return this.base + encodeRelPath(rel) + suffix
  }
}

/** 由任意 http(s) URL 构造 URL 直开数据源 */
export function sourceFromUrl(url: string, files?: ViewerSource['files']): ViewerSource {
  const clean = url.trim()
  const i = clean.lastIndexOf('/')
  const base = clean.slice(0, i + 1)
  const name = safeDecode(clean.slice(i + 1).split(/[?#]/)[0]) || '模型'
  let originLabel = clean
  try {
    originLabel = new URL(clean).host
  } catch {
    /* 保留原串 */
  }
  return { kind: 'url', baseUrl: base, relPath: name, name, files, originLabel }
}

/**
 * 尝试从“局域网共享直链”反查文件索引，增强外部资源容错。
 * 形如 http://ip:port/share/<id>/fs/<rel>（url 直开与 lan 来源均适用）。
 * 索引路径相对共享根目录：若 baseUrl 指向子目录，需把数据源重定基到
 * /fs/ 根并将子目录并入 relPath，否则解析器会拼出重复路径。
 */
export async function tryFetchShareIndex(source: ViewerSource): Promise<ViewerSource> {
  if (source.files?.length) return source
  const m = /^(https?:\/\/[^/]+)\/share\/([^/]+)\/fs\/(.*)$/.exec(source.baseUrl)
  if (!m) return source
  try {
    const resp = await fetch(`${m[1]}/api/shares/${m[2]}/index`)
    if (!resp.ok) return source
    const data = (await resp.json()) as { files: ViewerSource['files']; truncated: boolean }
    const fsRoot = `${m[1]}/share/${m[2]}/fs/`
    const sub = normalizeRel(safeDecode(m[3]))
    const rel = normalizeRel(source.relPath)
    return {
      ...source,
      baseUrl: fsRoot,
      relPath: sub ? `${sub}/${rel}` : rel,
      files: data.files,
      truncated: data.truncated,
    }
  } catch {
    return source
  }
}

/** 历史条目的入口 URL（local 返回本机绝对路径） */
export function historyEntryUrl(entry: HistoryEntry): string {
  if (entry.kind === 'local') return entry.localPath ?? entry.relPath
  return entry.baseUrl + encodeRelPath(entry.relPath)
}

/**
 * 由历史条目重建数据源（url / lan）。
 * local 来源的 token 仅本次会话有效，需经主进程重新打开根目录，返回 null 由调用方处理。
 */
export function sourceFromHistory(entry: HistoryEntry): ViewerSource | null {
  if (entry.kind === 'local') return null
  return {
    kind: entry.kind,
    baseUrl: entry.baseUrl,
    relPath: entry.relPath,
    name: entry.name,
    originLabel: entry.originLabel,
  }
}