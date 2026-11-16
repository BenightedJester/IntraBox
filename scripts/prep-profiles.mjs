/** 为双实例联调准备隔离 profile（名称 + 共享目录） */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-assets')
const profiles = [
  ['a', '测试机A', 's-a', 'A 的模型库'],
  ['b', '测试机B', 's-b', 'B 的模型库'],
]
for (const [p, name, sid, sname] of profiles) {
  const dir = path.join(process.env.APPDATA, `intrabox-profile-${p}`)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'intrabox.json')
  let data = {}
  try { data = JSON.parse(fs.readFileSync(file, 'utf-8')) } catch { /* 首次 */ }
  data.name = name
  data.shares = [{ id: sid, name: sname, path: root, enabled: true }]
  data.serviceEnabled = true
  data.history = { model: [], tiles: [] }
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
  console.log('profile', p, '->', file)
}