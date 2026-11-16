import { onBeforeUnmount, reactive, type Ref } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

export type BgTheme = 'deep' | 'light' | 'blueprint' | 'custom'

export interface SceneSettings {
  bgTheme: BgTheme
  bgColor: string
  exposure: number
  envIntensity: number
  keyIntensity: number
  keyAzimuth: number
  wireframe: boolean
  showGrid: boolean
  showAxes: boolean
  showParticles: boolean
  shadows: boolean
  autoRotate: boolean
  rotateSpeed: number
}

/** 主题对应的近似纯色（截图合成 / 雾色用） */
export const THEME_SOLID: Record<BgTheme, string> = {
  deep: '#0a0e1a',
  light: '#dfe4f0',
  blueprint: '#081524',
  custom: '#0a0e1a',
}

export interface ThreeScene {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  settings: SceneSettings
  /** 当前模型包围球（加载后更新） */
  bounds: THREE.Sphere
  setModel: (object: THREE.Object3D | null) => void
  fitView: (animate?: boolean) => void
  applySettings: () => void
  screenshot: () => string
  dispose: () => void
  /** 每帧回调（动画混合器等） */
  onFrame: ((dt: number) => void) | null
}

/**
 * 创建三维查看场景：渲染器 / 相机 / 轨道控制 / 灯光 / 环境 / 网格 / 粒子。
 * 单一 RAF 循环驱动，阻尼控制，像素比封顶，环境贴图一次性烘焙。
 */
export function useThreeScene(container: Ref<HTMLElement | undefined>): ThreeScene {
  const settings = reactive<SceneSettings>({
    bgTheme: 'deep',
    bgColor: '#12203a',
    exposure: 1.05,
    envIntensity: 0.9,
    keyIntensity: 2.2,
    keyAzimuth: 35,
    wireframe: false,
    showGrid: true,
    showAxes: false,
    showParticles: true,
    shadows: true,
    autoRotate: false,
    rotateSpeed: 1.2,
  })

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = settings.exposure
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.shadowMap.autoUpdate = false // 静态阴影：按需更新

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 8000)
  camera.position.set(4, 3, 6)

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.screenSpacePanning = true
  controls.autoRotateSpeed = settings.rotateSpeed

  // 环境反射（一次性烘焙）
  const pmrem = new THREE.PMREMGenerator(renderer)
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.environment = envTex
  scene.environmentIntensity = settings.envIntensity

  // 灯光：半球底光 + 主光（带阴影）+ 轮廓光 + 补光
  const hemi = new THREE.HemisphereLight(0xbcd0ff, 0x20242e, 0.5)
  scene.add(hemi)

  const key = new THREE.DirectionalLight(0xffffff, settings.keyIntensity)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.bias = -0.0004
  key.shadow.normalBias = 0.02
  scene.add(key)
  scene.add(key.target)

  const rim = new THREE.DirectionalLight(0x66aaff, 1.1)
  rim.position.set(-5, 4, -6)
  scene.add(rim)

  const fill = new THREE.DirectionalLight(0xffe6c0, 0.4)
  fill.position.set(3, -2, 4)
  scene.add(fill)

  // 网格 + 阴影承接面 + 坐标轴
  const grid = new THREE.GridHelper(20, 40, 0x3a4a7a, 0x232c4a)
  ;(grid.material as THREE.Material).transparent = true
  ;(grid.material as THREE.Material).opacity = 0.5
  scene.add(grid)

  const shadowPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.ShadowMaterial({ opacity: 0.28 }),
  )
  shadowPlane.rotation.x = -Math.PI / 2
  shadowPlane.receiveShadow = true
  scene.add(shadowPlane)

  const axes = new THREE.AxesHelper(2)
  axes.visible = false
  scene.add(axes)

  // 漂浮尘埃粒子（氛围）
  const particleCount = 260
  const pGeo = new THREE.BufferGeometry()
  const pPos = new Float32Array(particleCount * 3)
  for (let i = 0; i < particleCount; i++) {
    pPos[i * 3] = (Math.random() - 0.5) * 2
    pPos[i * 3 + 1] = Math.random()
    pPos[i * 3 + 2] = (Math.random() - 0.5) * 2
  }
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3))
  const pMat = new THREE.PointsMaterial({
    color: 0x8fa8ff,
    size: 0.02,
    transparent: true,
    opacity: 0.4,
    sizeAttenuation: true,
    depthWrite: false,
  })
  const particles = new THREE.Points(pGeo, pMat)
  scene.add(particles)

  const bounds = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 2)
  let model: THREE.Object3D | null = null
  let disposed = false
  let raf = 0
  const clock = new THREE.Clock()

  function applySettings() {
    renderer.toneMappingExposure = settings.exposure
    scene.environmentIntensity = settings.envIntensity
    key.intensity = settings.keyIntensity
    controls.autoRotate = settings.autoRotate
    controls.autoRotateSpeed = settings.rotateSpeed
    grid.visible = settings.showGrid
    axes.visible = settings.showAxes
    particles.visible = settings.showParticles
    shadowPlane.visible = settings.shadows
    renderer.shadowMap.enabled = settings.shadows
    key.castShadow = settings.shadows

    // 主光方位
    const a = (settings.keyAzimuth * Math.PI) / 180
    const r = bounds.radius * 2.5
    key.position.set(
      bounds.center.x + Math.cos(a) * r,
      bounds.center.y + r * 0.9,
      bounds.center.z + Math.sin(a) * r,
    )
    key.target.position.copy(bounds.center)
    const sc = key.shadow.camera
    sc.left = sc.bottom = -bounds.radius * 1.6
    sc.right = sc.top = bounds.radius * 1.6
    sc.near = 0.1
    sc.far = r * 3
    sc.updateProjectionMatrix()
    renderer.shadowMap.needsUpdate = true

    // 线框
    if (model) {
      model.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (mesh.isMesh && mesh.material) {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
          for (const m of mats) {
            if ('wireframe' in m) (m as THREE.MeshStandardMaterial).wireframe = settings.wireframe
          }
        }
      })
    }
  }

  function fitView() {
    const c = bounds.center
    const r = Math.max(bounds.radius, 0.001)
    controls.target.copy(c)
    const dir = new THREE.Vector3(1, 0.62, 1).normalize()
    camera.position.copy(c).addScaledVector(dir, r * 2.4)
    camera.near = r / 200
    camera.far = r * 200
    camera.updateProjectionMatrix()
    controls.minDistance = r * 0.15
    controls.maxDistance = r * 30
    controls.update()
    applySettings()
  }

  function setModel(object: THREE.Object3D | null) {
    if (model) {
      scene.remove(model)
      disposeObject(model)
    }
    model = object
    if (object) {
      scene.add(object)
      const box = new THREE.Box3().setFromObject(object)
      if (!box.isEmpty()) {
        box.getBoundingSphere(bounds)
      }
      // 网格 / 承接面贴合模型底部与尺度
      const size = bounds.radius * 4
      grid.scale.setScalar(Math.max(size / 20, 0.01))
      grid.position.set(bounds.center.x, box.min.y, bounds.center.z)
      shadowPlane.scale.setScalar(Math.max(size / 60, 0.01))
      shadowPlane.position.set(bounds.center.x, box.min.y - bounds.radius * 0.001, bounds.center.z)
      axes.scale.setScalar(Math.max(bounds.radius * 0.6, 0.01))
      axes.position.copy(bounds.center)
      // 粒子包围模型
      particles.scale.setScalar(bounds.radius * 3)
      particles.position.copy(bounds.center).add(new THREE.Vector3(0, -bounds.radius * 0.5, 0))
      pMat.size = bounds.radius * 0.012
      // 阴影
      object.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (mesh.isMesh) {
          mesh.castShadow = true
          mesh.receiveShadow = true
        }
      })
      fitView()
    }
    renderer.shadowMap.needsUpdate = true
  }

  function screenshot(): string {
    // 合成纯色背景后导出
    const prevBg = scene.background
    const solid = settings.bgTheme === 'custom' ? settings.bgColor : THEME_SOLID[settings.bgTheme]
    scene.background = new THREE.Color(solid)
    renderer.render(scene, camera)
    const url = renderer.domElement.toDataURL('image/png')
    scene.background = prevBg
    return url
  }

  // 尺寸自适应
  function resize() {
    const el = container.value
    if (!el) return
    const w = el.clientWidth
    const h = el.clientHeight
    if (w === 0 || h === 0) return
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  const ro = new ResizeObserver(resize)

  function loop() {
    if (disposed) return
    raf = requestAnimationFrame(loop)
    const dt = Math.min(clock.getDelta(), 0.1)
    controls.update()
    if (particles.visible) particles.rotation.y += dt * 0.03
    if (api.onFrame) api.onFrame(dt)
    renderer.render(scene, camera)
  }

  const api: ThreeScene = {
    renderer,
    scene,
    camera,
    controls,
    settings,
    bounds,
    setModel,
    fitView,
    applySettings,
    screenshot,
    onFrame: null,
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      if (model) disposeObject(model)
      disposeObject(grid)
      disposeObject(shadowPlane)
      disposeObject(axes)
      disposeObject(particles)
      envTex.dispose()
      pmrem.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    },
  }

  // 挂载
  const el = container.value
  if (el) {
    el.appendChild(renderer.domElement)
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    ro.observe(el)
    resize()
  }
  applySettings()
  loop()

  onBeforeUnmount(() => api.dispose())

  return api
}

/** 递归释放几何体 / 材质 / 贴图 */
export function disposeObject(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (mesh.geometry) mesh.geometry.dispose()
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
    if (mat) {
      const mats = Array.isArray(mat) ? mat : [mat]
      for (const m of mats) {
        for (const key of Object.keys(m)) {
          const val = (m as unknown as Record<string, unknown>)[key]
          if (val && (val as THREE.Texture).isTexture) (val as THREE.Texture).dispose()
        }
        m.dispose()
      }
    }
  })
}