<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import * as THREE from 'three'
import { useThreeScene } from '../composables/useThreeScene'
import { loadModel, type LoadedModel, type ModelStats } from '../utils/modelLoader'
import { useLanStore } from '../stores/lan'
import { formatBytes, downloadDataUrl } from '../utils/format'
import { sourceFromUrl, sourceFromHistory, historyEntryUrl, tryFetchShareIndex, type ResourceResolver } from '../utils/viewerSource'
import { isModelFile, type ViewerSource, type LocalRootInfo, type HistoryEntry } from '../shared/lan-types'
import OpenFromLanDialog from '../components/OpenFromLanDialog.vue'
import HistoryDrawer from '../components/HistoryDrawer.vue'

const router = useRouter()
const store = useLanStore()

const container = ref<HTMLElement>()
const scene = ref<ReturnType<typeof useThreeScene>>()
const loading = ref(false)
const loadProgress = ref(0)
const errorMsg = ref('')
const dragOver = ref(false)
const source = ref<ViewerSource | null>(null)
const stats = ref<ModelStats>({ meshes: 0, vertices: 0, triangles: 0, materials: 0, textures: 0 })
const format = ref('')
const missing = ref<string[]>([])
const resolverRef = ref<ResourceResolver | null>(null)

// 动画
const clips = ref<THREE.AnimationClip[]>([])
const clipIndex = ref(0)
const playing = ref(false)
const animSpeed = ref(1)
let mixer: THREE.AnimationMixer | null = null
let activeAction: THREE.AnimationAction | null = null

// 对话框
const lanDialog = ref(false)
const urlDialog = ref(false)
const urlInput = ref('')
const candidateDialog = ref(false)
const candidates = ref<LocalRootInfo | null>(null)
const historyDrawer = ref(false)
const recentUrls = computed(() =>
  store.state.history.model.filter((e) => e.kind === 'url').slice(0, 6).map(historyEntryUrl),
)
const quickHistory = computed(() => store.state.history.model.slice(0, 4))

const hasModel = computed(() => !!source.value && !loading.value && !errorMsg.value)
const bgClass = computed(() => `viewer-bg--${scene.value?.settings.bgTheme ?? 'deep'}`)
const bgStyle = computed(() => {
  const s = scene.value?.settings
  if (s?.bgTheme === 'custom') return { background: s.bgColor }
  return {}
})

// ---------------- 场景初始化 ----------------
onMounted(async () => {
  await nextTick()
  scene.value = useThreeScene(container)
  scene.value.onFrame = (dt) => {
    if (mixer && playing.value) mixer.update(dt * animSpeed.value)
  }
  // 面板控件实时应用
  watch(
    () => ({ ...scene.value!.settings }),
    () => scene.value?.applySettings(),
    { deep: true },
  )

  // 来自其它页面的跳转
  const pending = store.takePendingOpen('model')
  if (pending) void openSource(pending.source)
})

// ---------------- 打开来源 ----------------
async function openSource(src: ViewerSource) {
  if (!scene.value) return
  loading.value = true
  loadProgress.value = 0
  errorMsg.value = ''
  missing.value = []
  stopAnimation()
  try {
    let finalSrc = src
    if (src.kind !== 'local') finalSrc = await tryFetchShareIndex(src)
    const loaded: LoadedModel = await loadModel(finalSrc, scene.value.renderer, (p) => {
      loadProgress.value = Math.round(p * 100)
    })
    source.value = finalSrc
    stats.value = loaded.stats
    format.value = loaded.format
    resolverRef.value = loaded.resolver
    missing.value = loaded.resolver.missing
    scene.value.setModel(loaded.object)
    setupAnimations(loaded)
    void store.pushHistory('model', finalSrc)
    ElMessage.success(`已加载 ${loaded.stats.meshes} 个网格 · ${loaded.stats.vertices.toLocaleString()} 顶点`)
  } catch (err) {
    console.error('[model] 加载失败', err)
    errorMsg.value = String(err instanceof Error ? err.message : err)
    source.value = null
    scene.value.setModel(null)
  } finally {
    loading.value = false
  }
}

function setupAnimations(loaded: LoadedModel) {
  clips.value = loaded.animations
  clipIndex.value = 0
  if (loaded.animations.length > 0) {
    mixer = new THREE.AnimationMixer(loaded.object)
    playClip(0)
  } else {
    mixer = null
  }
}

function playClip(index: number) {
  if (!mixer || !clips.value[index]) return
  activeAction?.stop()
  activeAction = mixer.clipAction(clips.value[index])
  activeAction.reset().play()
  playing.value = true
}

function stopAnimation() {
  activeAction?.stop()
  mixer?.stopAllAction()
  mixer = null
  activeAction = null
  playing.value = false
  clips.value = []
}

function togglePlay() {
  if (!mixer) return
  playing.value = !playing.value
}

function onClipChange(i: number) {
  playClip(i)
}

// ---------------- 打开方式 ----------------
async function pickFile() {
  const info = await window.api.model.pickFile()
  if (!info) return
  await openLocalInfo(info, info.candidates[0]?.p)
}

async function pickFolder() {
  const info = await window.api.model.pickFolder()
  if (!info) return
  if (info.candidates.length === 0) {
    ElMessage.warning('该文件夹内没有支持的模型文件')
    return
  }
  if (info.candidates.length === 1) await openLocalInfo(info, info.candidates[0].p)
  else {
    candidates.value = info
    candidateDialog.value = true
  }
}

async function openLocalInfo(info: LocalRootInfo, relPath?: string) {
  if (!relPath) return
  const src = await window.api.source.fromLocal(info, relPath)
  candidateDialog.value = false
  await openSource(src)
}

async function openPaths(paths: string[]) {
  try {
    const info = await window.api.model.openPaths(paths)
    if (info.candidates.length === 0) {
      ElMessage.warning('拖入的内容中没有支持的模型文件')
      return
    }
    // 拖入单个模型文件时意图明确：直接打开（主进程已把它排到候选首位），
    // 仅当拖入文件夹且存在多个候选时才弹出选择对话框
    const singleFile = paths.length === 1 && isModelFile(paths[0])
    if (info.candidates.length === 1 || singleFile) await openLocalInfo(info, info.candidates[0].p)
    else {
      candidates.value = info
      candidateDialog.value = true
    }
  } catch (err) {
    ElMessage.error('打开失败：' + String(err))
  }
}

function openUrlDialog() {
  urlInput.value = ''
  urlDialog.value = true
}

async function confirmUrl() {
  const url = urlInput.value.trim()
  if (!url) return
  if (!/^https?:\/\//i.test(url) && !url.startsWith('intrabox://')) {
    ElMessage.warning('请输入 http(s) 地址')
    return
  }
  urlDialog.value = false
  await openSource(sourceFromUrl(url))
}

function onLanOpen(src: ViewerSource) {
  void openSource(src)
}

/** 从历史记录重开：url / lan 直接重建数据源；local 需按绝对路径重新打开根目录 */
async function openHistory(entry: HistoryEntry) {
  if (entry.kind !== 'local') {
    const src = sourceFromHistory(entry)
    if (src) await openSource(src)
    return
  }
  try {
    let info: LocalRootInfo
    try {
      info = await window.api.model.openPaths([entry.root!])
    } catch {
      // 原根目录已不存在时，退化为按入口文件重新定根
      info = await window.api.model.openPaths([entry.localPath!])
    }
    const rootNorm = info.root.replace(/\\/g, '/')
    const fileNorm = (entry.localPath ?? '').replace(/\\/g, '/')
    const rel = fileNorm.startsWith(rootNorm + '/') ? fileNorm.slice(rootNorm.length + 1) : entry.relPath
    const src = await window.api.source.fromLocal(info, rel)
    await openSource(src)
  } catch (err) {
    console.error('[model] 历史重开失败', err)
    ElMessage.error('打开失败：文件不存在或已被移动')
  }
}

function reload() {
  if (source.value) void openSource(source.value)
}

function closeModel() {
  stopAnimation()
  scene.value?.setModel(null)
  source.value = null
  errorMsg.value = ''
  missing.value = []
}

function resetView() {
  scene.value?.fitView()
}

function takeScreenshot() {
  if (!scene.value || !hasModel.value) return
  const url = scene.value.screenshot()
  downloadDataUrl(url, `${source.value?.name || 'model'}-${Date.now()}.png`)
  ElMessage.success('截图已保存')
}

// ---------------- 拖拽 ----------------
function onDragOver(e: DragEvent) {
  e.preventDefault()
  dragOver.value = true
}
function onDragLeave() {
  dragOver.value = false
}
async function onDrop(e: DragEvent) {
  e.preventDefault()
  dragOver.value = false
  const files = Array.from(e.dataTransfer?.files ?? [])
  const paths = files.map((f) => window.api.getPathForFile(f)).filter(Boolean)
  if (paths.length > 0) await openPaths(paths)
}

const missingPreview = computed(() => missing.value.slice(0, 12))

// 供自动化测试访问
if (new URLSearchParams(location.search).has('debug')) {
  ;(window as any).__model = {
    get scene() {
      return scene.value
    },
    get stats() {
      return stats.value
    },
    get source() {
      return source.value
    },
    get missing() {
      return missing.value
    },
    get history() {
      return store.state.history.model
    },
    openSource,
    openPaths,
    openHistory,
  }
}
</script>

<template>
  <div class="viewer ib-dark" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
    <!-- 顶栏 -->
    <header class="viewer__top">
      <el-button :icon="'ArrowLeft'" text class="top-back" @click="router.back()">返回</el-button>
      <div class="top-title">
        <el-icon :size="18" class="top-title__icon"><Box /></el-icon>
        <span>三维模型查看</span>
      </div>
      <div class="top-source" v-if="source">
        <el-tag size="small" effect="dark" type="info">{{ format.toUpperCase() }}</el-tag>
        <span class="top-source__name" :title="source.originLabel">{{ source.name }}</span>
        <span class="top-source__origin">{{ source.originLabel }}</span>
      </div>
      <div class="top-actions">
        <el-button size="small" :icon="'Document'" @click="pickFile">打开文件</el-button>
        <el-button size="small" :icon="'FolderOpened'" @click="pickFolder">打开文件夹</el-button>
        <el-button size="small" :icon="'Link'" @click="openUrlDialog">URL</el-button>
        <el-button size="small" :icon="'Connection'" @click="lanDialog = true">局域网</el-button>
        <el-button size="small" :icon="'Clock'" @click="historyDrawer = true">历史</el-button>
      </div>
    </header>

    <div class="viewer__body">
      <!-- 画布区 -->
      <div class="viewer__stage" :class="bgClass" :style="bgStyle">
        <div ref="container" class="viewer__canvas" />

        <!-- 加载 -->
        <transition name="fade">
          <div v-if="loading" class="stage-overlay">
            <div class="loader-ring" />
            <p>正在加载模型…</p>
            <el-progress :percentage="loadProgress" :stroke-width="6" style="width: 240px" />
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
            <el-icon :size="46"><Box /></el-icon>
          </div>
          <h3>拖入模型，或选择打开方式</h3>
          <p>支持 gltf · glb · obj · fbx · stl · ply · dae</p>
          <div class="stage-empty__chips">
            <span>多文件外部资源自动解析</span>
            <span>Draco / KTX2 / Meshopt 离线解码</span>
            <span>中文 / 空格路径兼容</span>
          </div>
          <div class="stage-empty__actions">
            <el-button type="primary" :icon="'FolderOpened'" @click="pickFolder">打开文件夹</el-button>
            <el-button :icon="'Document'" @click="pickFile">打开文件</el-button>
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

        <!-- 拖拽遮罩 -->
        <transition name="fade">
          <div v-if="dragOver" class="drop-mask">
            <el-icon :size="44"><UploadFilled /></el-icon>
            <p>松开以打开模型（支持文件夹 / 多文件）</p>
          </div>
        </transition>

        <!-- 左下统计 HUD -->
        <div v-if="hasModel" class="stage-hud">
          <div class="hud-item"><b>{{ stats.meshes }}</b>网格</div>
          <div class="hud-item"><b>{{ stats.vertices.toLocaleString() }}</b>顶点</div>
          <div class="hud-item"><b>{{ stats.triangles.toLocaleString() }}</b>三角面</div>
          <div class="hud-item"><b>{{ stats.materials }}</b>材质</div>
          <div class="hud-item"><b>{{ stats.textures }}</b>贴图</div>
        </div>

        <!-- 缺失资源提示 -->
        <el-popover v-if="missing.length > 0" placement="top" width="320" trigger="hover">
          <template #reference>
            <div class="stage-missing">
              <el-icon><WarningFilled /></el-icon>
              {{ missing.length }} 个外部资源缺失
            </div>
          </template>
          <div class="missing-list">
            <div v-for="m in missingPreview" :key="m" class="missing-list__item">{{ m }}</div>
            <div v-if="missing.length > 12" class="missing-list__more">…等共 {{ missing.length }} 项</div>
          </div>
        </el-popover>
      </div>

      <!-- 右侧常驻控制面板 -->
      <aside class="panel">
        <div v-if="scene" class="panel__scroll">
          <section class="panel__section">
            <div class="panel__heading">显示</div>
            <div class="ctrl">
              <label>背景主题</label>
              <el-select v-model="scene!.settings.bgTheme" size="small" :disabled="!scene">
                <el-option label="深空" value="deep" />
                <el-option label="浅色" value="light" />
                <el-option label="蓝图" value="blueprint" />
                <el-option label="自定义" value="custom" />
              </el-select>
            </div>
            <div class="ctrl" v-if="scene?.settings.bgTheme === 'custom'">
              <label>背景色</label>
              <el-color-picker v-model="scene!.settings.bgColor" size="small" />
            </div>
            <div class="ctrl-row">
              <div class="ctrl-inline"><label>线框</label><el-switch v-model="scene!.settings.wireframe" size="small" :disabled="!scene" /></div>
              <div class="ctrl-inline"><label>网格</label><el-switch v-model="scene!.settings.showGrid" size="small" :disabled="!scene" /></div>
            </div>
            <div class="ctrl-row">
              <div class="ctrl-inline"><label>坐标轴</label><el-switch v-model="scene!.settings.showAxes" size="small" :disabled="!scene" /></div>
              <div class="ctrl-inline"><label>尘埃粒子</label><el-switch v-model="scene!.settings.showParticles" size="small" :disabled="!scene" /></div>
            </div>
            <div class="ctrl-inline ctrl-inline--wide"><label>阴影</label><el-switch v-model="scene!.settings.shadows" size="small" :disabled="!scene" /></div>
          </section>

          <section class="panel__section">
            <div class="panel__heading">相机</div>
            <div class="ctrl-inline ctrl-inline--wide"><label>自动旋转</label><el-switch v-model="scene!.settings.autoRotate" size="small" :disabled="!scene" /></div>
            <div class="ctrl">
              <label>旋转速度 <b>{{ scene?.settings.rotateSpeed.toFixed(1) }}</b></label>
              <el-slider v-model="scene!.settings.rotateSpeed" :min="0.2" :max="6" :step="0.1" size="small" :disabled="!scene" />
            </div>
            <el-button size="small" :icon="'Aim'" :disabled="!hasModel" @click="resetView" style="width: 100%">重置视角</el-button>
          </section>

          <section class="panel__section">
            <div class="panel__heading">灯光与色调</div>
            <div class="ctrl">
              <label>曝光 <b>{{ scene?.settings.exposure.toFixed(2) }}</b></label>
              <el-slider v-model="scene!.settings.exposure" :min="0.2" :max="2.5" :step="0.01" size="small" :disabled="!scene" />
            </div>
            <div class="ctrl">
              <label>环境反射 <b>{{ scene?.settings.envIntensity.toFixed(2) }}</b></label>
              <el-slider v-model="scene!.settings.envIntensity" :min="0" :max="2" :step="0.01" size="small" :disabled="!scene" />
            </div>
            <div class="ctrl">
              <label>主光强度 <b>{{ scene?.settings.keyIntensity.toFixed(1) }}</b></label>
              <el-slider v-model="scene!.settings.keyIntensity" :min="0" :max="4" :step="0.1" size="small" :disabled="!scene" />
            </div>
            <div class="ctrl">
              <label>主光方位 <b>{{ scene?.settings.keyAzimuth }}°</b></label>
              <el-slider v-model="scene!.settings.keyAzimuth" :min="0" :max="360" :step="1" size="small" :disabled="!scene" />
            </div>
          </section>

          <section class="panel__section" v-if="clips.length > 0">
            <div class="panel__heading">动画 · {{ clips.length }}</div>
            <div class="ctrl">
              <label>片段</label>
              <el-select :model-value="clipIndex" size="small" @change="onClipChange(Number($event))">
                <el-option v-for="(c, i) in clips" :key="i" :label="c.name || `片段 ${i + 1}`" :value="i" />
              </el-select>
            </div>
            <div class="ctrl">
              <label>播放速度 <b>{{ animSpeed.toFixed(1) }}×</b></label>
              <el-slider v-model="animSpeed" :min="0.1" :max="3" :step="0.1" size="small" />
            </div>
            <el-button size="small" :icon="playing ? 'VideoPause' : 'VideoPlay'" style="width: 100%" @click="togglePlay">
              {{ playing ? '暂停' : '播放' }}
            </el-button>
          </section>

          <section class="panel__section">
            <div class="panel__heading">操作</div>
            <div class="panel__btns">
              <el-button size="small" :icon="'Camera'" :disabled="!hasModel" @click="takeScreenshot">截图</el-button>
              <el-button size="small" :icon="'Refresh'" :disabled="!source" @click="reload">重载</el-button>
              <el-button size="small" :icon="'Close'" :disabled="!source" @click="closeModel">关闭</el-button>
            </div>
          </section>
        </div>
        <div v-else class="panel__placeholder">场景初始化…</div>
      </aside>
    </div>

    <!-- URL 对话框 -->
    <el-dialog v-model="urlDialog" title="从 URL 打开模型" width="520px" class="ib-dark" append-to-body>
      <el-input v-model="urlInput" placeholder="https://example.com/model/scene.gltf" @keyup.enter="confirmUrl">
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

    <!-- 候选入口选择 -->
    <el-dialog v-model="candidateDialog" title="选择要打开的模型" width="520px" class="ib-dark" append-to-body>
      <p class="candidate-hint">文件夹「{{ candidates?.name }}」中有 {{ candidates?.candidates.length }} 个模型文件：</p>
      <div class="candidate-list">
        <button
          v-for="c in candidates?.candidates"
          :key="c.p"
          class="candidate-item"
          @click="openLocalInfo(candidates!, c.p)"
        >
          <el-icon><Box /></el-icon>
          <span class="candidate-item__path">{{ c.p }}</span>
          <span class="candidate-item__size">{{ formatBytes(c.s) }}</span>
        </button>
      </div>
    </el-dialog>

    <!-- 局域网打开 -->
    <OpenFromLanDialog v-model="lanDialog" filter="model" @open="onLanOpen" />

    <!-- 打开历史 -->
    <HistoryDrawer v-model="historyDrawer" viewer="model" @open="openHistory" />
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
  color: var(--ib-violet);
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
}
.viewer__canvas {
  position: absolute;
  inset: 0;
}

/* 背景主题 */
.viewer-bg--deep {
  background: radial-gradient(120% 120% at 50% 0%, #1a2138 0%, #0a0e1a 60%, #06080f 100%);
}
.viewer-bg--light {
  background: radial-gradient(120% 120% at 50% 0%, #f2f5fc 0%, #dfe4f0 60%, #c8d0e2 100%);
}
.viewer-bg--blueprint {
  background:
    linear-gradient(rgba(60, 130, 200, 0.07) 1px, transparent 1px),
    linear-gradient(90deg, rgba(60, 130, 200, 0.07) 1px, transparent 1px),
    radial-gradient(120% 120% at 50% 0%, #0d2137 0%, #081524 70%);
  background-size: 32px 32px, 32px 32px, 100% 100%;
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
  border: 3px solid rgba(145, 99, 255, 0.2);
  border-top-color: var(--ib-violet);
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
}
.stage-empty__icon {
  width: 92px;
  height: 92px;
  border-radius: 26px;
  background: linear-gradient(135deg, rgba(145, 99, 255, 0.22), rgba(23, 195, 230, 0.16));
  border: 1px solid rgba(145, 99, 255, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ib-violet);
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
  border-color: var(--ib-violet);
  color: var(--ib-space-ink);
  background: rgba(145, 99, 255, 0.14);
}

.drop-mask {
  position: absolute;
  inset: 0;
  background: rgba(145, 99, 255, 0.14);
  border: 2px dashed var(--ib-violet);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--ib-violet);
  z-index: 6;
  pointer-events: none;
}
.drop-mask p {
  font-size: 15px;
  font-weight: 600;
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

.stage-missing {
  position: absolute;
  right: 16px;
  bottom: 16px;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(245, 165, 36, 0.14);
  border: 1px solid rgba(245, 165, 36, 0.4);
  color: var(--ib-amber);
  border-radius: 9px;
  padding: 7px 12px;
  font-size: 12px;
  cursor: help;
}
.missing-list {
  max-height: 240px;
  overflow-y: auto;
}
.missing-list__item {
  font-size: 12px;
  padding: 3px 0;
  color: var(--ib-ink-2);
  word-break: break-all;
}
.missing-list__more {
  font-size: 11px;
  color: var(--ib-ink-3);
  padding-top: 4px;
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
.panel__placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--ib-space-ink-3);
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
  color: var(--ib-violet);
  margin-bottom: 12px;
  text-transform: uppercase;
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

.candidate-hint {
  font-size: 13px;
  color: var(--ib-space-ink-2);
  margin: 0 0 12px;
}
.candidate-list {
  max-height: 360px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.candidate-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--ib-space-border);
  background: rgba(122, 144, 210, 0.06);
  cursor: pointer;
  color: var(--ib-space-ink);
  font-family: inherit;
  text-align: left;
}
.candidate-item:hover {
  border-color: var(--ib-violet);
  background: rgba(145, 99, 255, 0.12);
}
.candidate-item__path {
  flex: 1;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.candidate-item__size {
  font-size: 11px;
  color: var(--ib-space-ink-3);
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