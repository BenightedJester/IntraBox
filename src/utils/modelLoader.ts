import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js'
import type { ViewerSource } from '../shared/lan-types'
import { extOf } from './format'
import { ResourceResolver, sourceDirUrl, sourceEntryUrl } from './viewerSource'

export interface LoadedModel {
  object: THREE.Object3D
  animations: THREE.AnimationClip[]
  stats: ModelStats
  resolver: ResourceResolver
  format: string
}

export interface ModelStats {
  meshes: number
  vertices: number
  triangles: number
  materials: number
  textures: number
}

/** 解码器静态资源基址（开发 / 生产通用，由 document.baseURI 推导） */
function assetBase(sub: string): string {
  return new URL(sub, document.baseURI).href
}

let dracoLoader: DRACOLoader | null = null
let ktx2Loader: KTX2Loader | null = null

function getDraco(): DRACOLoader {
  if (!dracoLoader) {
    dracoLoader = new DRACOLoader()
    dracoLoader.setDecoderPath(assetBase('draco/'))
    dracoLoader.setDecoderConfig({ type: 'js' }) // js 解码器兼容性最佳，避免个别环境 wasm 问题
  }
  return dracoLoader
}

function getKtx2(renderer: THREE.WebGLRenderer): KTX2Loader {
  if (!ktx2Loader) {
    ktx2Loader = new KTX2Loader()
    ktx2Loader.setTranscoderPath(assetBase('basis/'))
    ktx2Loader.detectSupport(renderer)
  }
  return ktx2Loader
}

function computeStats(object: THREE.Object3D): ModelStats {
  const stats: ModelStats = { meshes: 0, vertices: 0, triangles: 0, materials: 0, textures: 0 }
  const matSet = new Set<THREE.Material>()
  const texSet = new Set<THREE.Texture>()
  object.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (mesh.isMesh && mesh.geometry) {
      stats.meshes++
      const geo = mesh.geometry
      const pos = geo.getAttribute('position')
      if (pos) stats.vertices += pos.count
      if (geo.index) stats.triangles += geo.index.count / 3
      else if (pos) stats.triangles += pos.count / 3
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) {
        if (!m) continue
        matSet.add(m)
        for (const key of Object.keys(m)) {
          const val = (m as unknown as Record<string, unknown>)[key]
          if (val && (val as THREE.Texture).isTexture) texSet.add(val as THREE.Texture)
        }
      }
    }
    const points = o as THREE.Points
    if (points.isPoints && points.geometry) {
      const pos = points.geometry.getAttribute('position')
      if (pos) stats.vertices += pos.count
    }
  })
  stats.materials = matSet.size
  stats.textures = texSet.size
  stats.triangles = Math.round(stats.triangles)
  return stats
}

/** 为加载器构建带资源重写的 LoadingManager */
function makeManager(resolver: ResourceResolver, onProgress?: (p: number) => void): THREE.LoadingManager {
  const manager = new THREE.LoadingManager()
  manager.setURLModifier(resolver.resolve)
  manager.onProgress = (_url, loaded, total) => {
    if (onProgress && total > 0) onProgress(loaded / total)
  }
  manager.onError = (url) => {
    resolver.markMissing(url)
  }
  return manager
}

/**
 * 加载模型入口文件。统一处理 gltf/glb/obj(+mtl)/fbx/stl/ply/dae，
 * 并通过 ResourceResolver 解决多文件外部资源路径问题。
 */
export async function loadModel(
  source: ViewerSource,
  renderer: THREE.WebGLRenderer,
  onProgress?: (p: number) => void,
): Promise<LoadedModel> {
  const resolver = new ResourceResolver(source)
  const manager = makeManager(resolver, onProgress)
  const entryUrl = sourceEntryUrl(source)
  const dirUrl = sourceDirUrl(source)
  const ext = extOf(source.relPath)

  let object: THREE.Object3D
  let animations: THREE.AnimationClip[] = []

  switch (ext) {
    case 'gltf':
    case 'glb': {
      const loader = new GLTFLoader(manager)
      loader.setDRACOLoader(getDraco())
      loader.setKTX2Loader(getKtx2(renderer))
      loader.setMeshoptDecoder(MeshoptDecoder)
      loader.setPath(dirUrl)
      const gltf: GLTF = await loader.loadAsync(entryUrl, (e) => {
        if (onProgress && e.total > 0) onProgress(e.loaded / e.total)
      })
      object = gltf.scene
      animations = gltf.animations
      break
    }
    case 'obj': {
      // 先尝试读取同名 / mtllib 引用的 mtl，赋予材质
      const loader = new OBJLoader(manager)
      let materials: MTLLoader.MaterialCreator | null = null
      try {
        const text = await fetchText(entryUrl)
        const mtlMatch = /^mtllib\s+(.+)$/im.exec(text)
        if (mtlMatch) {
          const mtlName = mtlMatch[1].trim()
          const mtlUrl = resolver.resolve(dirUrl + mtlName)
          const mtlLoader = new MTLLoader(manager)
          mtlLoader.setPath(dirUrl)
          const creator = await mtlLoader.loadAsync(mtlUrl)
          creator.preload()
          materials = creator
        }
      } catch {
        /* 无 mtl 时按默认材质渲染 */
      }
      if (materials) loader.setMaterials(materials)
      object = await loader.loadAsync(entryUrl, (e) => {
        if (onProgress && e.total > 0) onProgress(e.loaded / e.total)
      })
      break
    }
    case 'fbx': {
      const loader = new FBXLoader(manager)
      loader.setPath(dirUrl)
      object = await loader.loadAsync(entryUrl, (e) => {
        if (onProgress && e.total > 0) onProgress(e.loaded / e.total)
      })
      animations = object.animations ?? []
      break
    }
    case 'stl': {
      const loader = new STLLoader(manager)
      const geo = await loader.loadAsync(entryUrl, (e) => {
        if (onProgress && e.total > 0) onProgress(e.loaded / e.total)
      })
      geo.computeVertexNormals()
      const mat = new THREE.MeshStandardMaterial({ color: 0xb8c4e0, metalness: 0.15, roughness: 0.55 })
      object = new THREE.Mesh(geo, mat)
      break
    }
    case 'ply': {
      const loader = new PLYLoader(manager)
      const geo = await loader.loadAsync(entryUrl, (e) => {
        if (onProgress && e.total > 0) onProgress(e.loaded / e.total)
      })
      geo.computeVertexNormals()
      const hasColor = !!geo.getAttribute('color')
      // PLYLoader 对纯点云不生成 index；含面片时会生成 index
      if (!geo.index) {
        const mat = new THREE.PointsMaterial({ size: 0.02, vertexColors: hasColor, color: hasColor ? 0xffffff : 0x9fb4ff })
        object = new THREE.Points(geo, mat)
      } else {
        const mat = new THREE.MeshStandardMaterial({
          color: hasColor ? 0xffffff : 0xb8c4e0,
          vertexColors: hasColor,
          metalness: 0.1,
          roughness: 0.6,
        })
        object = new THREE.Mesh(geo, mat)
      }
      break
    }
    case 'dae': {
      const loader = new ColladaLoader(manager)
      loader.setPath(dirUrl)
      const collada = await loader.loadAsync(entryUrl, (e) => {
        if (onProgress && e.total > 0) onProgress(e.loaded / e.total)
      })
      if (!collada) throw new Error('DAE 文件解析失败')
      object = collada.scene
      // 类型定义未声明 animations，运行时 ColladaLoader 会返回动画剪辑
      animations = (collada as { animations?: THREE.AnimationClip[] }).animations ?? []
      break
    }
    default:
      throw new Error(`暂不支持的格式：.${ext}（支持 gltf/glb/obj/fbx/stl/ply/dae）`)
  }

  // 归一化：居中到原点附近，便于统一布光（保留原始尺度比例）
  const stats = computeStats(object)
  return { object, animations, stats, resolver, format: ext }
}

async function fetchText(url: string): Promise<string> {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return resp.text()
}