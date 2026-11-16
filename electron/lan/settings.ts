import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import type { HistoryEntry, HistoryLists, ShareInfo } from '../../src/shared/lan-types'
import { HISTORY_LIMIT, historyKey } from '../../src/shared/lan-types'

export interface SettingsData {
  /** 本机唯一标识（持久化） */
  id: string
  /** 对外展示的设备名 */
  name: string
  shares: ShareInfo[]
  /** 模型 / 3D Tiles 查看器打开历史 */
  history: HistoryLists
  serviceEnabled: boolean
}

function isHistoryEntry(e: unknown): e is HistoryEntry {
  if (!e || typeof e !== 'object') return false
  const h = e as HistoryEntry
  return (
    typeof h.id === 'string' &&
    (h.kind === 'local' || h.kind === 'lan' || h.kind === 'url') &&
    typeof h.name === 'string' &&
    typeof h.baseUrl === 'string' &&
    typeof h.relPath === 'string' &&
    typeof h.ts === 'number'
  )
}

/** 旧版 recent（纯 URL 列表）迁移为历史条目 */
function migrateRecent(raw: unknown, kind: 'model' | 'tiles'): HistoryEntry[] {
  const list = (raw as { recent?: Record<string, unknown> } | null)?.recent
  const urls = list && Array.isArray(list[kind]) ? (list[kind] as unknown[]) : []
  const out: HistoryEntry[] = []
  for (const u of urls) {
    if (typeof u !== 'string' || !/^https?:\/\//i.test(u)) continue
    const i = u.lastIndexOf('/')
    out.push({
      id: randomUUID(),
      kind: 'url',
      name: decodeURIComponent(u.slice(i + 1)) || u,
      baseUrl: u.slice(0, i + 1),
      relPath: decodeURIComponent(u.slice(i + 1)),
      originLabel: (() => {
        try {
          return new URL(u).host
        } catch {
          return u
        }
      })(),
      ts: Date.now(),
    })
  }
  return out.slice(0, HISTORY_LIMIT)
}

/**
 * 设置持久化：userData/intrabox.json
 * 写入采用 临时文件 + rename，避免损坏。
 */
export class Settings {
  private file: string
  private saveTimer: NodeJS.Timeout | null = null
  data: SettingsData

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, 'intrabox.json')
    this.data = this.load()
  }

  private defaults(): SettingsData {
    return {
      id: randomUUID(),
      name: os.hostname(),
      shares: [],
      history: { model: [], tiles: [] },
      serviceEnabled: true,
    }
  }

  private load(): SettingsData {
    const base = this.defaults()
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Partial<SettingsData> & { recent?: unknown }
      const shares = Array.isArray(raw.shares)
        ? raw.shares.filter(
            (s): s is ShareInfo =>
              !!s && typeof s.id === 'string' && typeof s.path === 'string' && fs.existsSync(s.path),
          )
        : []
      const pick = (kind: 'model' | 'tiles'): HistoryEntry[] => {
        const list = raw.history?.[kind]
        if (Array.isArray(list)) {
          return list.filter(isHistoryEntry).slice(0, HISTORY_LIMIT)
        }
        return migrateRecent(raw, kind)
      }
      return {
        id: typeof raw.id === 'string' && raw.id ? raw.id : base.id,
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : base.name,
        shares,
        history: { model: pick('model'), tiles: pick('tiles') },
        serviceEnabled: raw.serviceEnabled !== false,
      }
    } catch {
      return base
    }
  }

  /** 延迟合并写入 */
  save() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.flush(), 250)
  }

  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    try {
      const tmp = this.file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8')
      fs.renameSync(tmp, this.file)
    } catch (err) {
      console.error('[settings] 保存失败', err)
    }
  }

  /** 记录一次打开：同一入口去重置顶（复用原条目 id），最多保留 HISTORY_LIMIT 条 */
  pushHistory(kind: keyof HistoryLists, entry: HistoryEntry) {
    const key = historyKey(entry)
    const prev = this.data.history[kind].find((e) => historyKey(e) === key)
    const rest = this.data.history[kind].filter((e) => historyKey(e) !== key)
    rest.unshift({ ...entry, id: entry.id || prev?.id || randomUUID(), ts: Date.now() })
    this.data.history[kind] = rest.slice(0, HISTORY_LIMIT)
    this.save()
  }

  removeHistory(kind: keyof HistoryLists, id: string) {
    this.data.history[kind] = this.data.history[kind].filter((e) => e.id !== id)
    this.save()
  }

  clearHistory(kind: keyof HistoryLists) {
    this.data.history[kind] = []
    this.save()
  }
}