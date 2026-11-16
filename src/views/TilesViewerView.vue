<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import { useLanStore } from '../stores/lan'
import { formatBytes, downloadDataUrl } from '../utils/format'
import { sourceEntryUrl, sourceFromUrl, sourceFromHistory, historyEntryUrl, tryFetchShareIndex } from '../utils/viewerSource'
import type { ViewerSource, HistoryEntry } from '../shared/lan-types'
import OpenFromLanDialog from '../components/OpenFromLanDialog.vue'
import HistoryDrawer from '../components/HistoryDrawer.vue'

const router = useRouter()
const store = useLanStore()

const container = ref<HTMLElement>()
const loading = ref(false)
const errorMsg = ref('')
const source = ref<ViewerSource | null>(null)
const localMode = ref(false)
const failedCount = ref(0)
const stats = reactive({ loaded: 0, total: 0, pending: 0, memory: 0 })

/** 运行时统计（公开类型定义未暴露 statistics，按实际结构断言） */
interface TilesetStatistics {
  numberOfTilesWithContentReady: number
  numberOfTilesTotal: number
  numberOfPendingRequests: number
  numberOfTilesProcessing: number
}

const lanDialog = ref(false)
const urlDialog = ref(false)
const urlInput = ref('')
const historyDrawer = ref(false)
const recentUrls = computed(() =>
  store.state.history.tiles.filter((e) => e.kind === 'url').slice(0, 6).map(historyEntryUrl),
)
const quickHistory = computed(() => store.state.history.tiles.slice(0, 4))

const settings = reactive({
  /** 屏幕空间误差：越小越精细 */
  sse: 16,
  style: 'original' as 'original' | 'white' | 'xray',
  wireframe: false,
  boundingVolumes: false,
  pointAttenuation: true,
  pointSize: 4,
  edl: false,
  basemap: 'offline' as 'offline' | 'dark' | 'osm',
  showGlobe: true,
  atmosphere: true,
  stars: true,
  lighting: false,
  autoRotate: false,
  rotateSpeed: 1,
})

const hasTiles = computed(() => !!source.value && !loading.value && !errorMsg.value)

let viewer: Cesium.Viewer | null = null
let tileset: Cesium.Cesium3DTileset | null = null
let imageryLayer: Cesium.ImageryLayer | null = null
let basemapToken = 0
let statsTimer: number | null = null
let handler: Cesium.ScreenSpaceEventHandler | null = null
let interacting = false
let wheelTimer: number | null = null
let lastOrbit = 0
let loadToken = 0

// ---------------- 场景初始化 ----------------
onMounted(async () => {
  await nextTick()
  if (!container.value) return
  try {
    viewer = new Cesium.Viewer(container.value, {
      baseLayer: false,
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      scene3DOnly: true,
      msaaSamples: 4,
      contextOptions: { webgl: { preserveDrawingBuffer: true } },
    })
  } catch (err) {
    console.error('[tiles] WebGL 初始化失败', err)
    errorMsg.value = 'WebGL 初始化失败：' + String(err instanceof Error ? err.message : err)
    return
  }
  viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 1.5)
  const scene = viewer.scene
  scene.backgroundColor = Cesium.Color.fromCssColorString('#070a12')
  scene.globe.baseColor = Cesium.Color.fromCssColorString('#0a0f1e')
  scene.globe.enableLighting = settings.lighting
  if (scene.sun) scene.sun.show = false
  if (scene.moon) scene.moon.show = false
  scene.fog.enabled = false
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = settings.atmosphere
  scene.skyBox = new Cesium.SkyBox({
    sources: {
      positiveX: Cesium.buildModuleUrl('Assets/Textures/SkyBox/tycho2t3_80_px.jpg'),
      negativeX: Cesium.buildModuleUrl('Assets/Textures/SkyBox/tycho2t3_80_mx.jpg'),
      positiveY: Cesium.buildModuleUrl('Assets/Textures/SkyBox/tycho2t3_80_py.jpg'),
      negativeY: Cesium.buildModuleUrl('Assets/Textures/SkyBox/tycho2t3_80_my.jpg'),
      positiveZ: Cesium.buildModuleUrl('Assets/Textures/SkyBox/tycho2t3_80_pz.jpg'),
      negativeZ: Cesium.buildModuleUrl('Assets/Textures/SkyBox/tycho2t3_80_mz.jpg'),
    },
  })
  scene.skyBox.show = settings.stars

  // 初始相机：太空视角俯瞰地球
  scene.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(105, 28, 2.2e7),
  })

  // 用户交互时暂停自动旋转
  handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas)
  const down = () => { interacting = true }
  const up = () => { interacting = false }
  for (const t of [
    Cesium.ScreenSpaceEventType.LEFT_DOWN,
    Cesium.ScreenSpaceEventType.MIDDLE_DOWN,
    Cesium.ScreenSpaceEventType.RIGHT_DOWN,
  ]) handler.setInputAction(down, t)
  for (const t of [
    Cesium.ScreenSpaceEventType.LEFT_UP,
    Cesium.ScreenSpaceEventType.MIDDLE_UP,
    Cesium.ScreenSpaceEventType.RIGHT_UP,
  ]) handler.setInputAction(up, t)
  handler.setInputAction(() => {
    interacting = true
    if (wheelTimer) window.clearTimeout(wheelTimer)
    wheelTimer = window.setTimeout(() => { interacting = false }, 900)
  }, Cesium.ScreenSpaceEventType.WHEEL)

  scene.preRender.addEventListener(orbitStep)

  void switchBasemap(settings.basemap)
  statsTimer = window.setInterval(pollStats, 500)

  const pending = store.takePendingOpen('tiles')
  if (pending) void openSource(pending.source)
})

onBeforeUnmount(() => {
  if (statsTimer) window.clearInterval(statsTimer)
  if (wheelTimer) window.clearTimeout(wheelTimer)
  handler?.destroy()
  tileset = null
  if (viewer && !viewer.isDestroyed()) viewer.destroy()
  viewer = null
})

// ---------------- 自动旋转 ----------------
function orbitStep() {
  if (!viewer || !tileset || !settings.autoRotate || interacting) {
    lastOrbit = performance.now()
    return
  }
  const now = performance.now()
  const dt = Math.min((now - lastOrbit) / 1000, 0.1)
  lastOrbit = now
  const angle = settings.rotateSpeed * dt * 0.3
  if (angle === 0) return
  const cam = viewer.camera
  const center = tileset.boundingSphere.center
  // 地心坐标绕径向轴、局部坐标绕 Z 轴旋转
  const axis = localMode.value
    ? Cesium.Cartesian3.UNIT_Z
    : Cesium.Cartesian3.normalize(center, new Cesium.Cartesian3())
  const rot = Cesium.Matrix3.fromQuaternion(Cesium.Quaternion.fromAxisAngle(axis, angle))
  const offset = Cesium.Cartesian3.subtract(cam.positionWC, center, new Cesium.Cartesian3())
  cam.position = Cesium.Cartesian3.add(center, Cesium.Matrix3.multiplyByVector(rot, offset, new Cesium.Cartesian3()), new Cesium.Cartesian3())
  cam.direction = Cesium.Matrix3.multiplyByVector(rot, cam.directionWC, new Cesium.Cartesian3())
  cam.up = Cesium.Matrix3.multiplyByVector(rot, cam.upWC, new Cesium.Cartesian3())
  cam.right = Cesium.Cartesian3.cross(cam.direction, cam.up, new Cesium.Cartesian3())
}

// ---------------- 底图 ----------------
async function switchBasemap(kind: 'offline' | 'dark' | 'osm') {
  if (!viewer) return
  const token = ++basemapToken
  try {
    let layer: Cesium.ImageryLayer
    if (kind === 'osm') {
      layer = new Cesium.ImageryLayer(
        new Cesium.UrlTemplateImageryProvider({
          url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
          credit: '© OpenStreetMap contributors',
          maximumLevel: 19,
        }),
      )
    } else {
      const provider = await Cesium.TileMapServiceImageryProvider.fromUrl(
        Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII'),
      )
      layer = new Cesium.ImageryLayer(provider)
      if (kind === 'dark') {
        layer.brightness = 0.38
        layer.contrast = 1.15
        layer.saturation = 0.25
      }
    }
    if (token !== basemapToken || !viewer || viewer.isDestroyed()) {
      layer.destroy()
      return
    }
    if (imageryLayer) viewer.imageryLayers.remove(imageryLayer, true)
    imageryLayer = layer
    viewer.imageryLayers.add(layer)
  } catch (err) {
    console.error('[tiles] 底图加载失败', err)
    if (kind === 'osm') ElMessage.warning('在线底图加载失败，请检查网络')
  }
}

// ---------------- 打开来源 ----------------
async function openSource(src: ViewerSource) {
  if (!viewer) return
  const token = ++loadToken
  loading.value = true
  errorMsg.value = ''
  failedCount.value = 0
  removeTileset()
  try {
    let finalSrc = src
    if (src.kind !== 'local') finalSrc = await tryFetchShareIndex(src)
    const ts = await Cesium.Cesium3DTileset.fromUrl(sourceEntryUrl(finalSrc), {
      maximumScreenSpaceError: settings.sse,
    })
    if (token !== loadToken || !viewer || viewer.isDestroyed()) {
      ts.destroy()
      return
    }
    tileset = ts
    viewer.scene.primitives.add(ts)
    ts.tileFailed.addEventListener((err: { message?: string }) => {
      failedCount.value++
      console.warn('[tiles] 瓦片加载失败', err?.message)
    })
    source.value = finalSrc

    // 局部坐标检测：包围球中心远离地心 => 局部坐标模型，隐藏地球按模型方式观察
    const center = ts.boundingSphere.center
    localMode.value = Cesium.Cartesian3.magnitude(center) < 6e6
    if (localMode.value) {
      settings.showGlobe = false
      viewer.scene.globe.show = false
      if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = false
      flyToTileset(true)
      ElMessage.info('检测到局部坐标瓦片，已隐藏地球，按模型方式查看')
    } else {
      settings.showGlobe = true
      viewer.scene.globe.show = true
      if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = settings.atmosphere
      flyToTileset(false)
    }
    applyTilesetDisplay()
    void store.pushHistory('tiles', finalSrc)
  } catch (err) {
    if (token !== loadToken) return
    console.error('[tiles] 加载失败', err)
    errorMsg.value = String(err instanceof Error ? err.message : err)
    source.value = null
  } finally {
    if (token === loadToken) loading.value = false
  }
}

function flyToTileset(instant: boolean) {
  if (!viewer || !tileset) return
  // 取消进行中的相机飞行（如关闭瓦片时的回家动画），
  // 否则 setView 会被仍在继续的飞行覆盖，导致局部坐标瓦片不可见
  viewer.camera.cancelFlight()
  const sphere = tileset.boundingSphere
  const radius = Math.max(sphere.radius, 1)
  if (localMode.value) {
    // 局部坐标下 ENU 参考系在原点附近退化，直接用向量定位相机
    const center = sphere.center
    const destination = new Cesium.Cartesian3(
      center.x + radius * 1.5,
      center.y - radius * 1.5,
      center.z + radius * 1.1,
    )
    const direction = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.subtract(center, destination, new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    )
    viewer.camera.setView({ destination, orientation: { direction, up: Cesium.Cartesian3.UNIT_Z } })
    return
  }
  const offset = new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-30), radius * 2.2)
  if (instant) {
    viewer.camera.flyToBoundingSphere(sphere, { offset, duration: 0 })
  } else {
    viewer.flyTo(tileset, { offset, duration: 1.4 })
  }
}

function removeTileset() {
  if (tileset && viewer && !viewer.isDestroyed()) {
    viewer.scene.primitives.remove(tileset)
  }
  tileset = null
  stats.loaded = 0
  stats.total = 0
  stats.pending = 0
  stats.memory = 0
}

// ---------------- 面板控件应用 ----------------
function applyTilesetDisplay() {
  if (!tileset) return
  tileset.maximumScreenSpaceError = settings.sse
  tileset.debugWireframe = settings.wireframe
  tileset.debugShowBoundingVolume = settings.boundingVolumes
  tileset.pointCloudShading.attenuation = settings.pointAttenuation
  tileset.pointCloudShading.maximumAttenuation = settings.pointSize
  tileset.pointCloudShading.eyeDomeLighting = settings.edl
  switch (settings.style) {
    case 'white':
      tileset.style = new Cesium.Cesium3DTileStyle({ color: "color('#dfe6f5')" })
      break
    case 'xray':
      tileset.style = new Cesium.Cesium3DTileStyle({ color: "color('#17c3e6', 0.35)" })
      break
    default:
      tileset.style = undefined
  }
}

watch(
  () => [
    settings.sse, settings.style, settings.wireframe, settings.boundingVolumes,
    settings.pointAttenuation, settings.pointSize, settings.edl,
  ],
  applyTilesetDisplay,
)

watch(
  () => [settings.showGlobe, settings.atmosphere, settings.stars, settings.lighting],
  () => {
    if (!viewer) return
    viewer.scene.globe.show = settings.showGlobe && !localMode.value
    if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = settings.atmosphere && !localMode.value
    if (viewer.scene.skyBox) viewer.scene.skyBox.show = settings.stars
    viewer.scene.globe.enableLighting = settings.lighting
  },
)

watch(() => settings.basemap, (kind) => void switchBasemap(kind))

// ---------------- 统计 ----------------
function pollStats() {
  if (!tileset) return
  const s = (tileset as unknown as { statistics: TilesetStatistics }).statistics
  stats.loaded = s.numberOfTilesWithContentReady
  stats.total = s.numberOfTilesTotal
  stats.pending = s.numberOfPendingRequests + s.numberOfTilesProcessing
  stats.memory = tileset.totalMemoryUsageInBytes
}

// ---------------- 打开方式 ----------------
function openUrlDialog() {
  urlInput.value = ''
  urlDialog.value = true
}

async function confirmUrl() {
  const url = urlInput.value.trim()
  if (!url) return
  if (!/^https?:\/\//i.test(url)) {
    ElMessage.warning('请输入 http(s) 地址')
    return
  }
  urlDialog.value = false
  await openSource(sourceFromUrl(url))
}

function onLanOpen(src: ViewerSource) {
  void openSource(src)
}

async function openHistory(entry: HistoryEntry) {
  const src = sourceFromHistory(entry)
  if (src) await openSource(src)
}

function reload() {
  if (source.value) void openSource(source.value)
}

function closeTiles() {
  loadToken++
  removeTileset()
  source.value = null
  errorMsg.value = ''
  localMode.value = false
  failedCount.value = 0
  if (viewer) {
    settings.showGlobe = true
    viewer.scene.globe.show = true
    if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = settings.atmosphere
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(105, 28, 2.2e7),
      duration: 1.2,
    })
  }
}

function resetView() {
  flyToTileset(false)
}

function takeScreenshot() {
  if (!viewer || !hasTiles.value) return
  viewer.render()
  const url = (viewer.canvas as HTMLCanvasElement).toDataURL('image/png')
  downloadDataUrl(url, `${source.value?.name || 'tileset'}-${Date.now()}.png`)
  ElMessage.success('截图已保存')
}

// 供自动化测试访问
if (new URLSearchParams(location.search).has('debug')) {
  ;(window as any).__tiles = {
    get viewer() {
      return viewer
    },
    get tileset() {
      return tileset
    },
    get source() {
      return source.value
    },
    get stats() {
      return { ...stats }
    },
    get settings() {
      return settings
    },
    get failed() {
      return failedCount.value
    },
    get localMode() {
      return localMode.value
    },
    openSource,
    openHistory,
  }
}
</script>

<template>
  <div class="viewer ib-dark">
    <!-- 顶栏 -->
    <header class="viewer__top">
      <el-button :icon="'ArrowLeft'" text class="top-back" @click="router.back()">返回</el-button>
      <div class="top-title">
        <el-icon :size="18" class="top-title__icon"><MapLocation /></el-icon>
        <span>3D Tiles 查看</span>
      </div>
      <div class="top-source" v-if="source">
        <el-tag size="small" effect="dark" type="success">TILESET</el-tag>
        <span class="top-source__name" :title="source.originLabel">{{ source.name }}</span>
        <span class="top-source__origin">{{ source.originLabel }}</span>
        <el-tag v-if="localMode" size="small" effect="plain" type="warning">局部坐标</el-tag>
      </div>
      <div class="top-actions">
        <el-button size="small" :icon="'Link'" @click="openUrlDialog">URL</el-button>
        <el-button size="small" :icon="'Connection'" @click="lanDialog = true">局域网</el-button>
        <el-button size="small" :icon="'Clock'" @click="historyDrawer = true">历史</el-button>
      </div>
    </header>

    <div class="viewer__body">
      <!-- 画布区 -->
      <div class="viewer__stage">
        <div ref="container" class="viewer__canvas" />

        <!-- 加载 -->
        <transition name="fade">
          <div v-if="loading" class="stage-overlay">
            <div class="loader-ring" />
            <p>正在加载瓦片集…</p>
          </div>
        </transition>

        <!-- 错误 -->
        <div v-if="errorMsg && !loading" class="stage-overlay stage-overlay--error">
          <el-icon :size="36"><WarningFilled /></el-icon>
          <p>加载失败</p>
          <span class="stage-error__msg">{{ errorMsg }}</span>
          <el-button size="small" type="primary" @click="reload">重试</el-button>
        </div>

        <!-- 空状态 -->
        <div v-if="!source && !loading && !errorMsg" class="stage-empty">
          <div class="stage-empty__icon">
            <el-icon :size="46"><MapLocation /></el-icon>
          </div>
          <h3>在地球上打开 3D Tiles</h3>
          <p>基于 Cesium · 支持倾斜摄影 / 城市白模 / 点云 / 局部坐标模型</p>
          <div class="stage-empty__chips">
            <span>离线地球底图</span>
            <span>自动定位到瓦片范围</span>
            <span>白模 / X 射线样式</span>
          </div>
          <div class="stage-empty__actions">
            <el-button type="primary" :icon="'Link'" @click="openUrlDialog">从 URL 打开</el-button>
            <el-button :icon="'Connection'" @click="lanDialog = true">从局域网打开</el-button>
          </div>
          <div v-if="quickHistory.length" class="stage-empty__history">
            <span class="stage-empty__history-label">最近打开</span>
            <button
              v-for="h in quickHistory"
              :key="h.id"
              class="history-chip"
              :title="h.originLabel"
              @click="openHistory(h)"
            >
              <el-icon :size="12"><Clock /></el-icon>
              {{ h.name }}
            </button>
          </div>
        </div>

        <!-- 左下统计 HUD -->
        <div v-if="hasTiles" class="stage-hud">
          <div class="hud-item"><b>{{ stats.loaded }}</b>已加载瓦片</div>
          <div class="hud-item"><b>{{ stats.total }}</b>瓦片总数</div>
          <div class="hud-item"><b>{{ stats.pending }}</b>待加载</div>
          <div class="hud-item"><b>{{ formatBytes(stats.memory) }}</b>显存占用</div>
          <div v-if="failedCount > 0" class="hud-item hud-item--warn"><b>{{ failedCount }}</b>加载失败</div>
        </div>
      </div>

      <!-- 右侧常驻控制面板 -->
      <aside class="panel">
        <div class="panel__scroll">
          <section class="panel__section">
            <div class="panel__heading">瓦片渲染</div>
            <div class="ctrl">
              <label>精细度（SSE）<b>{{ settings.sse }}</b></label>
              <el-slider v-model="settings.sse" :min="1" :max="64" :step="1" size="small" :disabled="!tileset" />
            </div>
            <div class="ctrl">
              <label>渲染样式</label>
              <el-select v-model="settings.style" size="small" :disabled="!tileset">
                <el-option label="原始材质" value="original" />
                <el-option label="城市白模" value="white" />
                <el-option label="X 射线" value="xray" />
              </el-select>
            </div>
            <div class="ctrl-row">
              <div class="ctrl-inline"><label>线框</label><el-switch v-model="settings.wireframe" size="small" :disabled="!tileset" /></div>
              <div class="ctrl-inline"><label>包围体</label><el-switch v-model="settings.boundingVolumes" size="small" :disabled="!tileset" /></div>
            </div>
          </section>

          <section class="panel__section">
            <div class="panel__heading">点云</div>
            <div class="ctrl-inline ctrl-inline--wide"><label>尺寸衰减</label><el-switch v-model="settings.pointAttenuation" size="small" :disabled="!tileset" /></div>
            <div class="ctrl">
              <label>点大小 <b>{{ settings.pointSize }}</b></label>
              <el-slider v-model="settings.pointSize" :min="1" :max="16" :step="1" size="small" :disabled="!tileset" />
            </div>
            <div class="ctrl-inline ctrl-inline--wide"><label>Eye-Dome 光照</label><el-switch v-model="settings.edl" size="small" :disabled="!tileset" /></div>
          </section>

          <section class="panel__section">
            <div class="panel__heading">地球与天空</div>
            <div class="ctrl">
              <label>底图</label>
              <el-select v-model="settings.basemap" size="small">
                <el-option label="离线自然地球" value="offline" />
                <el-option label="深色地球" value="dark" />
                <el-option label="在线 OSM" value="osm" />
              </el-select>
            </div>
            <div class="ctrl-row">
              <div class="ctrl-inline"><label>地球</label><el-switch v-model="settings.showGlobe" size="small" :disabled="localMode" /></div>
              <div class="ctrl-inline"><label>大气</label><el-switch v-model="settings.atmosphere" size="small" :disabled="localMode" /></div>
            </div>
            <div class="ctrl-row">
              <div class="ctrl-inline"><label>星空</label><el-switch v-model="settings.stars" size="small" /></div>
              <div class="ctrl-inline"><label>日照</label><el-switch v-model="settings.lighting" size="small" /></div>
            </div>
            <p v-if="settings.basemap === 'osm'" class="panel__note">地图数据 © OpenStreetMap 贡献者</p>
            <p v-if="localMode" class="panel__note">局部坐标模式：地球已隐藏</p>
          </section>

          <section class="panel__section">
            <div class="panel__heading">相机</div>
            <div class="ctrl-inline ctrl-inline--wide"><label>自动环绕</label><el-switch v-model="settings.autoRotate" size="small" :disabled="!tileset" /></div>
            <div class="ctrl">
              <label>环绕速度 <b>{{ settings.rotateSpeed.toFixed(1) }}</b></label>
              <el-slider v-model="settings.rotateSpeed" :min="0.2" :max="6" :step="0.1" size="small" :disabled="!tileset" />
            </div>
            <el-button size="small" :icon="'Aim'" :disabled="!hasTiles" @click="resetView" style="width: 100%">定位到瓦片</el-button>
          </section>

          <section class="panel__section">
            <div class="panel__heading">操作</div>
            <div class="panel__btns">
              <el-button size="small" :icon="'Camera'" :disabled="!hasTiles" @click="takeScreenshot">截图</el-button>
              <el-button size="small" :icon="'Refresh'" :disabled="!source" @click="reload">重载</el-button>
              <el-button size="small" :icon="'Close'" :disabled="!source" @click="closeTiles">关闭</el-button>
            </div>
          </section>
        </div>
      </aside>
    </div>

    <!-- URL 对话框 -->
    <el-dialog v-model="urlDialog" title="从 URL 打开 3D Tiles" width="520px" class="ib-dark" append-to-body>
      <el-input v-model="urlInput" placeholder="https://example.com/tiles/tileset.json" @keyup.enter="confirmUrl">
        <template #prepend><el-icon><Link /></el-icon></template>
      </el-input>
      <div v-if="recentUrls.length" class="recent">
        <div class="recent__label">最近打开</div>
        <button v-for="u in recentUrls" :key="u" class="recent__item" @click="urlInput = u">{{ u }}</button>
      </div>
      <template #footer>
        <el-button @click="urlDialog = false">取消</el-button>
        <el-button type="primary" @click="confirmUrl">打开</el-button>
      </template>
    </el-dialog>

    <!-- 局域网打开 -->
    <OpenFromLanDialog v-model="lanDialog" filter="tiles" @open="onLanOpen" />

    <!-- 打开历史 -->
    <HistoryDrawer v-model="historyDrawer" viewer="tiles" @open="openHistory" />
  </div>
</template>

<style scoped>
.viewer {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--ib-space-0);
  overflow: hidden;
}

.viewer__top {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--ib-space-border);
  background: rgba(12, 17, 32, 0.85);
  backdrop-filter: blur(10px);
  z-index: 5;
}
.top-back {
  color: var(--ib-space-ink-2);
}
.top-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  font-size: 15px;
  color: var(--ib-space-ink);
}
.top-title__icon {
  color: var(--ib-green);
}
.top-source {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
}
.top-source__name {
  font-size: 13px;
  color: var(--ib-space-ink);
  font-weight: 600;
  white-space: nowrap;
}
.top-source__origin {
  font-size: 11.5px;
  color: var(--ib-space-ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.top-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.viewer__body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.viewer__stage {
  flex: 1;
  min-width: 0;
  position: relative;
  overflow: hidden;
  background: var(--ib-space-0);
}
.viewer__canvas {
  position: absolute;
  inset: 0;
}
.viewer__canvas :deep(.cesium-viewer),
.viewer__canvas :deep(.cesium-widget) {
  width: 100%;
  height: 100%;
}
.viewer__canvas :deep(.cesium-viewer-bottom) {
  display: none;
}
.viewer__canvas :deep(.cesium-widget-credits) {
  display: none !important;
}

.stage-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  background: rgba(7, 10, 18, 0.72);
  backdrop-filter: blur(4px);
  color: var(--ib-space-ink);
  z-index: 4;
}
.stage-overlay p {
  margin: 0;
  font-size: 14px;
}
.stage-overlay--error {
  color: var(--ib-rose);
}
.stage-error__msg {
  max-width: 480px;
  text-align: center;
  font-size: 12.5px;
  color: var(--ib-space-ink-2);
  word-break: break-all;
}
.loader-ring {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  border: 3px solid rgba(23, 201, 138, 0.2);
  border-top-color: var(--ib-green);
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.stage-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  text-align: center;
  color: var(--ib-space-ink-2);
  padding: 24px;
  z-index: 3;
  background: radial-gradient(120% 120% at 50% 0%, rgba(26, 33, 56, 0.9) 0%, rgba(7, 10, 18, 0.94) 70%);
}
.stage-empty__icon {
  width: 92px;
  height: 92px;
  border-radius: 26px;
  background: linear-gradient(135deg, rgba(23, 201, 138, 0.2), rgba(23, 195, 230, 0.16));
  border: 1px solid rgba(23, 201, 138, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ib-green);
  margin-bottom: 8px;
}
.stage-empty h3 {
  margin: 0;
  font-size: 18px;
  color: var(--ib-space-ink);
}
.stage-empty p {
  margin: 0;
  font-size: 13px;
}
.stage-empty__chips {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: center;
  margin: 10px 0 18px;
}
.stage-empty__chips span {
  font-size: 11.5px;
  padding: 4px 10px;
  border-radius: 20px;
  background: rgba(122, 144, 210, 0.1);
  border: 1px solid var(--ib-space-border);
  color: var(--ib-space-ink-2);
}
.stage-empty__actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: center;
}
.stage-empty__history {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: center;
  margin-top: 18px;
}
.stage-empty__history-label {
  font-size: 11.5px;
  color: var(--ib-space-ink-3);
}
.history-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--ib-space-border);
  background: rgba(122, 144, 210, 0.08);
  color: var(--ib-space-ink-2);
  font-size: 12px;
  font-family: inherit;
  padding: 5px 11px;
  border-radius: 16px;
  cursor: pointer;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}
.history-chip:hover {
  border-color: var(--ib-green);
  color: var(--ib-space-ink);
  background: rgba(23, 201, 138, 0.14);
}

.stage-hud {
  position: absolute;
  left: 16px;
  bottom: 16px;
  display: flex;
  gap: 8px;
  z-index: 3;
}
.hud-item {
  background: rgba(12, 17, 32, 0.7);
  backdrop-filter: blur(8px);
  border: 1px solid var(--ib-space-border);
  border-radius: 9px;
  padding: 6px 11px;
  font-size: 11px;
  color: var(--ib-space-ink-3);
}
.hud-item b {
  display: block;
  font-size: 14px;
  color: var(--ib-space-ink);
  font-weight: 700;
}
.hud-item--warn {
  border-color: rgba(245, 165, 36, 0.4);
}
.hud-item--warn b {
  color: var(--ib-amber);
}

/* ---------- 控制面板 ---------- */
.panel {
  width: 300px;
  flex-shrink: 0;
  border-left: 1px solid var(--ib-space-border);
  background: rgba(12, 17, 32, 0.92);
  display: flex;
  flex-direction: column;
}
.panel__scroll {
  flex: 1;
  overflow-y: auto;
  padding: 6px 16px 20px;
}
.panel__section {
  padding: 14px 0;
  border-bottom: 1px solid var(--ib-space-border);
}
.panel__section:last-child {
  border-bottom: none;
}
.panel__heading {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1.5px;
  color: var(--ib-green);
  margin-bottom: 12px;
  text-transform: uppercase;
}
.panel__note {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--ib-space-ink-3);
}
.ctrl {
  margin-bottom: 12px;
}
.ctrl label {
  display: flex;
  justify-content: space-between;
  font-size: 12.5px;
  color: var(--ib-space-ink-2);
  margin-bottom: 5px;
}
.ctrl label b {
  color: var(--ib-space-ink);
  font-weight: 600;
}
.ctrl-row {
  display: flex;
  gap: 10px;
  margin-bottom: 10px;
}
.ctrl-inline {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background: rgba(122, 144, 210, 0.07);
  border: 1px solid var(--ib-space-border);
  border-radius: 9px;
  padding: 7px 10px;
}
.ctrl-inline--wide {
  margin-bottom: 10px;
}
.ctrl-inline label {
  font-size: 12.5px;
  color: var(--ib-space-ink-2);
}
.panel__btns {
  display: flex;
  gap: 6px;
}
.panel__btns .el-button {
  flex: 1;
}

.recent {
  margin-top: 14px;
}
.recent__label {
  font-size: 11px;
  color: var(--ib-space-ink-3);
  margin-bottom: 6px;
}
.recent__item {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: rgba(122, 144, 210, 0.08);
  color: var(--ib-space-ink-2);
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 7px;
  margin-bottom: 4px;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: inherit;
}
.recent__item:hover {
  background: rgba(122, 144, 210, 0.16);
  color: var(--ib-space-ink);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>