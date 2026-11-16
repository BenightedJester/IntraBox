/**
 * 生成联调测试资产（不入库）：
 * - 多文件 gltf（中文 / 空格路径 + 反斜杠 + 大小写不一致的外部资源引用）
 * - glb / obj+mtl / stl / ply(网格+点云) / dae
 * - 3D Tiles：ECEF（北京）与局部坐标两套 tileset + 中文名 b3dm
 * - 2MB 随机文件（聊天文件传输校验）
 *
 * 用法：node scripts/gen-test-assets.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-assets')
fs.rmSync(root, { recursive: true, force: true })

function put(rel, data) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, data)
  console.log('✓', rel, typeof data === 'string' ? `${data.length} chars` : `${data.length} bytes`)
}

// ---------------- PNG（64x64 棋盘格） ----------------
function crc32(buf) {
  let c, table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function makePng() {
  const W = 64, H = 64
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8; ihdr[9] = 6 // 8bit RGBA
  const raw = Buffer.alloc(H * (1 + W * 4))
  for (let y = 0; y < H; y++) {
    const row = y * (1 + W * 4)
    raw[row] = 0
    for (let x = 0; x < W; x++) {
      const i = row + 1 + x * 4
      const check = ((x >> 3) + (y >> 3)) % 2 === 0
      const edge = x < 2 || y < 2 || x >= W - 2 || y >= H - 2
      const [r, g, b] = edge ? [244, 81, 124] : check ? [79, 107, 255] : [240, 243, 255]
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = 255
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const png = makePng()

// ---------------- 立方体几何 ----------------
function boxGeometry(s = 1) {
  const faces = [
    { n: [1, 0, 0], v: [[s, -s, -s], [s, s, -s], [s, s, s], [s, -s, s]] },
    { n: [-1, 0, 0], v: [[-s, -s, s], [-s, s, s], [-s, s, -s], [-s, -s, -s]] },
    { n: [0, 1, 0], v: [[-s, s, -s], [-s, s, s], [s, s, s], [s, s, -s]] },
    { n: [0, -1, 0], v: [[-s, -s, s], [-s, -s, -s], [s, -s, -s], [s, -s, s]] },
    { n: [0, 0, 1], v: [[-s, -s, s], [s, -s, s], [s, s, s], [-s, s, s]] },
    { n: [0, 0, -1], v: [[s, -s, -s], [-s, -s, -s], [-s, s, -s], [s, s, -s]] },
  ]
  const pos = [], nor = [], uv = [], idx = []
  faces.forEach((f, fi) => {
    for (const p of f.v) { pos.push(...p); nor.push(...f.n) }
    uv.push(0, 0, 1, 0, 1, 1, 0, 1)
    const b = fi * 4
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3)
  })
  return { pos, nor, uv, idx }
}

function buildGltfBuffers({ pos, nor, uv, idx }) {
  const posB = Buffer.from(new Float32Array(pos).buffer)
  const norB = Buffer.from(new Float32Array(nor).buffer)
  const uvB = Buffer.from(new Float32Array(uv).buffer)
  const idxB = Buffer.from(new Uint16Array(idx).buffer)
  const bin = Buffer.concat([posB, norB, uvB, idxB])
  const views = [
    { buffer: 0, byteOffset: 0, byteLength: posB.length, target: 34962 },
    { buffer: 0, byteOffset: posB.length, byteLength: norB.length, target: 34962 },
    { buffer: 0, byteOffset: posB.length + norB.length, byteLength: uvB.length, target: 34962 },
    { buffer: 0, byteOffset: posB.length + norB.length + uvB.length, byteLength: idxB.length, target: 34963 },
  ]
  const min = [Math.min(...pos.filter((_, i) => i % 3 === 0)), Math.min(...pos.filter((_, i) => i % 3 === 1)), Math.min(...pos.filter((_, i) => i % 3 === 2))]
  const max = [Math.max(...pos.filter((_, i) => i % 3 === 0)), Math.max(...pos.filter((_, i) => i % 3 === 1)), Math.max(...pos.filter((_, i) => i % 3 === 2))]
  const accessors = [
    { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max },
    { bufferView: 1, componentType: 5126, count: nor.length / 3, type: 'VEC3' },
    { bufferView: 2, componentType: 5126, count: uv.length / 2, type: 'VEC2' },
    { bufferView: 3, componentType: 5123, count: idx.length, type: 'SCALAR' },
  ]
  return { bin, views, accessors }
}

function packGlb(json, bin) {
  const jsonB = Buffer.from(JSON.stringify(json), 'utf-8')
  const jsonPad = (4 - (jsonB.length % 4)) % 4
  const binPad = (4 - (bin.length % 4)) % 4
  const jsonChunk = Buffer.concat([jsonB, Buffer.alloc(jsonPad, 0x20)])
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPad, 0)])
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length
  const header = Buffer.alloc(12)
  header.write('glTF', 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8)
  const jh = Buffer.alloc(8)
  jh.writeUInt32LE(jsonChunk.length, 0); jh.write('JSON', 4)
  const bh = Buffer.alloc(8)
  bh.writeUInt32LE(binChunk.length, 0); bh.write('BIN\0', 4)
  return Buffer.concat([header, jh, jsonChunk, bh, binChunk])
}

const geo = boxGeometry(1)
const { bin, views, accessors } = buildGltfBuffers(geo)

// ---------------- 多文件 gltf（外部 bin + 贴图，反斜杠 + 大小写不一致） ----------------
const gltfJson = {
  asset: { version: '2.0', generator: 'intrabox-test' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: '测试立方体' }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
  materials: [{
    name: '棋盘材质',
    pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0.15, roughnessFactor: 0.5 },
  }],
  textures: [{ sampler: 0, source: 0 }],
  samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
  // 故意写成反斜杠 + 大小写不一致，验证 ResourceResolver 容错
  images: [{ uri: 'TEXTURES\\贴图 01.PNG' }],
  buffers: [{ uri: 'data/几何.bin', byteLength: bin.length }],
  bufferViews: views,
  accessors,
}
put('多文件模型/场景 主文件.gltf', JSON.stringify(gltfJson, null, 2))
put('多文件模型/data/几何.bin', bin)
put('多文件模型/textures/贴图 01.png', png)

// ---------------- GLB ----------------
const glbJson = JSON.parse(JSON.stringify(gltfJson))
delete glbJson.images; delete glbJson.textures; delete glbJson.samplers
glbJson.materials = [{ name: '靛蓝材质', pbrMetallicRoughness: { baseColorFactor: [0.31, 0.42, 1, 1], metallicFactor: 0.2, roughnessFactor: 0.45 } }]
glbJson.buffers = [{ byteLength: bin.length }]
const glb = packGlb(glbJson, bin)
put('单文件/立方体.glb', glb)

// ---------------- OBJ + MTL ----------------
const { pos, nor, uv, idx } = geo
let obj = '# intrabox test cube\nmtllib 立方体.mtl\nusemtl 棋盘材质\n'
for (let i = 0; i < pos.length; i += 3) obj += `v ${pos[i]} ${pos[i + 1]} ${pos[i + 2]}\n`
for (let i = 0; i < uv.length; i += 2) obj += `vt ${uv[i]} ${uv[i + 1]}\n`
for (let i = 0; i < nor.length; i += 3) obj += `vn ${nor[i]} ${nor[i + 1]} ${nor[i + 2]}\n`
obj += 's off\n'
for (let i = 0; i < idx.length; i += 3) {
  const [a, b, c] = [idx[i] + 1, idx[i + 1] + 1, idx[i + 2] + 1]
  obj += `f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}\n`
}
put('单文件/立方体.obj', obj)
put('单文件/立方体.mtl', 'newmtl 棋盘材质\nKd 1 1 1\nKa 0.2 0.2 0.2\nKs 0.1 0.1 0.1\nmap_Kd 贴图 01.png\n')
put('单文件/贴图 01.png', png)

// ---------------- STL（四面体） ----------------
const tet = [[1, 1, 1], [-1, -1, 1], [-1, 1, -1], [1, -1, -1]]
const tetFaces = [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]]
let stl = 'solid tetra\n'
for (const [a, b, c] of tetFaces) {
  const [p, q, r] = [tet[a], tet[b], tet[c]]
  const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]]
  const v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]]
  let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
  const l = Math.hypot(...n); n = n.map((x) => x / l)
  stl += `facet normal ${n.join(' ')}\n outer loop\n`
  for (const pt of [p, q, r]) stl += `  vertex ${pt.join(' ')}\n`
  stl += ' endloop\nendfacet\n'
}
stl += 'endsolid tetra\n'
put('单文件/四面体.stl', stl)

// ---------------- PLY 网格（金字塔） ----------------
const pyrV = [[0, 0, 1.4], [-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]]
const pyrF = [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 1], [1, 4, 3], [1, 3, 2]]
let ply = 'ply\nformat ascii 1.0\nelement vertex 5\nproperty float x\nproperty float y\nproperty float z\nelement face 6\nproperty list uchar int vertex_indices\nend_header\n'
for (const v of pyrV) ply += v.join(' ') + '\n'
for (const f of pyrF) ply += `3 ${f.join(' ')}\n`
put('单文件/金字塔.ply', ply)

// ---------------- PLY 点云 ----------------
const N = 400
let pts = `ply\nformat ascii 1.0\nelement vertex ${N}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`
const rng = crypto.createHash('sha256').update('seed').digest()
for (let i = 0; i < N; i++) {
  const t = i / N * Math.PI * 6
  const r = 0.2 + i / N * 1.2
  const x = Math.cos(t) * r, y = Math.sin(t) * r, z = (i / N - 0.5) * 2
  pts += `${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)} ${40 + (i % 200)} ${120 + (i % 100)} 255\n`
}
void rng
put('单文件/点云.ply', pts)

// ---------------- DAE ----------------
const daePos = []
const daeNor = []
for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
  daePos.push(x, y, z)
  const l = Math.sqrt(3)
  daeNor.push(x / l, y / l, z / l)
}
// 顶点序：0(-1,-1,-1) 1(-1,-1,1) 2(-1,1,-1) 3(-1,1,1) 4(1,-1,-1) 5(1,-1,1) 6(1,1,-1) 7(1,1,1)
const daeIdx = [0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3, 0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6]
const daeP = daeIdx.flatMap((i) => [i, i]).join(' ')
const dae = `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset><up_axis>Z_UP</up_axis><unit meter="1"/></asset>
  <library_geometries>
    <geometry id="box" name="测试立方体">
      <mesh>
        <source id="pos">
          <float_array id="pos-array" count="${daePos.length}">${daePos.join(' ')}</float_array>
          <technique_common>
            <accessor source="#pos-array" count="8" stride="3">
              <param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/>
            </accessor>
          </technique_common>
        </source>
        <source id="nor">
          <float_array id="nor-array" count="${daeNor.length}">${daeNor.map((v) => v.toFixed(5)).join(' ')}</float_array>
          <technique_common>
            <accessor source="#nor-array" count="8" stride="3">
              <param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/>
            </accessor>
          </technique_common>
        </source>
        <vertices id="verts"><input semantic="POSITION" source="#pos"/></vertices>
        <triangles count="12">
          <input semantic="VERTEX" source="#verts" offset="0"/>
          <input semantic="NORMAL" source="#nor" offset="1"/>
          <p>${daeP}</p>
        </triangles>
      </mesh>
    </geometry>
  </library_geometries>
  <library_visual_scenes>
    <visual_scene id="scene">
      <node id="box-node" name="立方体"><instance_geometry url="#box"/></node>
    </visual_scene>
  </library_visual_scenes>
  <scene><instance_visual_scene url="#scene"/></scene>
</COLLADA>
`
put('单文件/立方体.dae', dae)

// ---------------- b3dm ----------------
function packB3dm(glbBuf) {
  let ft = Buffer.from(JSON.stringify({ BATCH_LENGTH: 0 }), 'utf-8')
  while ((28 + ft.length) % 8 !== 0) ft = Buffer.concat([ft, Buffer.from(' ')])
  const total = 28 + ft.length + glbBuf.length
  const header = Buffer.alloc(28)
  header.write('b3dm', 0)
  header.writeUInt32LE(1, 4)
  header.writeUInt32LE(total, 8)
  header.writeUInt32LE(ft.length, 12)
  header.writeUInt32LE(0, 16)
  header.writeUInt32LE(0, 20)
  header.writeUInt32LE(0, 24)
  return Buffer.concat([header, ft, glbBuf])
}
// 建筑：底部 20x20m、高 30m 的体块（y-up glTF，Cesium 自动转 z-up）
const building = boxGeometry(1)
for (let i = 0; i < building.pos.length; i += 3) {
  building.pos[i] *= 10
  building.pos[i + 1] = building.pos[i + 1] * 15 + 15
  building.pos[i + 2] *= 10
}
const bGeo = buildGltfBuffers(building)
const bJson = JSON.parse(JSON.stringify(glbJson))
bJson.buffers = [{ byteLength: bGeo.bin.length }]
bJson.bufferViews = bGeo.views
bJson.accessors = bGeo.accessors
bJson.materials = [{ name: '幕墙', pbrMetallicRoughness: { baseColorFactor: [0.62, 0.72, 0.95, 1], metallicFactor: 0.55, roughnessFactor: 0.25 } }]
const b3dm = packB3dm(packGlb(bJson, bGeo.bin))

// ECEF 变换（北京 116.4E, 39.9N）
function ecefTransform(lonDeg, latDeg) {
  const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f)
  const lon = lonDeg * Math.PI / 180, lat = latDeg * Math.PI / 180
  const N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2)
  const x = N * Math.cos(lat) * Math.cos(lon)
  const y = N * Math.cos(lat) * Math.sin(lon)
  const z = N * (1 - e2) * Math.sin(lat)
  const east = [-Math.sin(lon), Math.cos(lon), 0]
  const north = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)]
  const up = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)]
  return [...east, 0, ...north, 0, ...up, 0, x, y, z, 1]
}
put('tiles/北京园区/主楼.b3dm', b3dm)
put('tiles/北京园区/tileset.json', JSON.stringify({
  asset: { version: '1.0', tilesetVersion: '1.0.0' },
  geometricError: 500,
  root: {
    transform: ecefTransform(116.4, 39.9),
    boundingVolume: { box: [0, 0, 15, 12, 0, 0, 0, 12, 0, 0, 0, 17] },
    geometricError: 0,
    refine: 'ADD',
    content: { uri: '主楼.b3dm' },
  },
}, null, 2))

// 局部坐标 tileset（无 transform，米级小坐标）
const small = boxGeometry(1)
const sGeo = buildGltfBuffers(small)
const sJson = JSON.parse(JSON.stringify(glbJson))
sJson.buffers = [{ byteLength: sGeo.bin.length }]
sJson.bufferViews = sGeo.views
sJson.accessors = sGeo.accessors
put('tiles/局部模型/局部.b3dm', packB3dm(packGlb(sJson, sGeo.bin)))
put('tiles/局部模型/tileset.json', JSON.stringify({
  asset: { version: '1.0' },
  geometricError: 50,
  root: {
    boundingVolume: { box: [0, 0, 0, 1.2, 0, 0, 0, 1.2, 0, 0, 0, 1.2] },
    geometricError: 0,
    refine: 'ADD',
    content: { uri: '局部.b3dm' },
  },
}, null, 2))

// ---------------- 聊天传输用大文件 ----------------
put('大文件测试.bin', crypto.randomBytes(2 * 1024 * 1024))

console.log('\n全部测试资产已生成于', root)