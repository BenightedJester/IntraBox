<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import QRCode from 'qrcode'
import { decodeQr, type QrSource } from '../utils/decodeQr'
import ScreenshotOverlay from '../components/ScreenshotOverlay.vue'

const router = useRouter()

// ---------------- 文字 -> 二维码 ----------------
const inputText = ref('')
const qrCanvas = ref<HTMLCanvasElement>()
const hasQr = ref(false)
let debounceTimer: number | undefined

watch(inputText, (val) => {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(() => renderQr(val), 200)
})

async function renderQr(text: string) {
  const canvas = qrCanvas.value
  if (!canvas) return
  const trimmed = text.trim()
  if (!trimmed) {
    // 清空画布
    const ctx = canvas.getContext('2d')
    ctx?.clearRect(0, 0, canvas.width, canvas.height)
    hasQr.value = false
    return
  }
  try {
    await QRCode.toCanvas(canvas, trimmed, {
      errorCorrectionLevel: 'M',
      width: 260,
      margin: 2,
    })
    hasQr.value = true
  } catch (err) {
    hasQr.value = false
    ElMessage.error('生成二维码失败：' + (err as Error).message)
  }
}

async function copyQrImage() {
  if (!hasQr.value || !qrCanvas.value) return
  try {
    const blob = await new Promise<Blob | null>((resolve) =>
      qrCanvas.value!.toBlob((b) => resolve(b), 'image/png'),
    )
    if (!blob) return
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    ElMessage.success('二维码图片已复制到剪贴板')
  } catch {
    ElMessage.error('复制失败')
  }
}

function saveQrImage() {
  if (!hasQr.value || !qrCanvas.value) return
  const dataUrl = qrCanvas.value.toDataURL('image/png')
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = 'qrcode.png'
  a.click()
}

// ---------------- 二维码 -> 文字 ----------------
const decodedText = ref('')
const resultImage = ref('') // 预览用的图片 URL
const decoding = ref(false)
const overlayImageUrl = ref('') // 非空时显示截图遮罩

async function handleDecode(source: QrSource, previewUrl: string) {
  decoding.value = true
  try {
    const text = await decodeQr(source)
    if (text) {
      decodedText.value = text
      resultImage.value = previewUrl
      ElMessage.success('识别成功')
    } else {
      decodedText.value = ''
      resultImage.value = previewUrl
      ElMessage.warning('未识别到二维码')
    }
  } catch {
    ElMessage.error('图片解析失败')
  } finally {
    decoding.value = false
  }
}

/** 将 File/Blob 转为 dataURL，便于预览与解码 */
function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

async function onPickImage() {
  const res = await window.api.pickImage()
  if (!res) return
  await handleDecode(res.dataUrl, res.dataUrl)
}

async function onCaptureScreen() {
  const dataUrl = await window.api.captureScreen()
  if (!dataUrl) {
    ElMessage.error('截图失败')
    return
  }
  overlayImageUrl.value = dataUrl
}

function onOverlayConfirm(croppedDataUrl: string) {
  overlayImageUrl.value = ''
  handleDecode(croppedDataUrl, croppedDataUrl)
}

function onOverlayCancel() {
  overlayImageUrl.value = ''
}

async function onReadClipboard() {
  const dataUrl = await window.api.readClipboardImage()
  if (!dataUrl) {
    ElMessage.warning('剪贴板中没有图片')
    return
  }
  await handleDecode(dataUrl, dataUrl)
}

async function copyDecodedText() {
  if (!decodedText.value) return
  try {
    await navigator.clipboard.writeText(decodedText.value)
    ElMessage.success('文本已复制')
  } catch {
    ElMessage.error('复制失败')
  }
}

// 粘贴图片：页面级监听
function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items
  if (!items) return
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) {
        e.preventDefault()
        void decodeImageFile(file)
      }
      return
    }
  }
}

async function decodeImageFile(file: File) {
  const dataUrl = await fileToDataUrl(file)
  await handleDecode(dataUrl, dataUrl)
}

// 拖拽
const dragOver = ref(false)
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
  const file = e.dataTransfer?.files?.[0]
  if (file && file.type.startsWith('image/')) {
    await decodeImageFile(file)
  } else {
    ElMessage.warning('请拖入图片文件')
  }
}

function goBack() {
  router.back()
}

onMounted(() => {
  window.addEventListener('paste', onPaste)
})

onBeforeUnmount(() => {
  window.removeEventListener('paste', onPaste)
  if (debounceTimer) clearTimeout(debounceTimer)
})
</script>

<template>
  <div class="qr-helper">
    <el-page-header class="qr-helper__header" @back="goBack">
      <template #content>
        <span class="qr-helper__title">二维码助手</span>
      </template>
    </el-page-header>

    <el-row :gutter="20" class="qr-helper__body">
      <!-- 左栏：文字 -> 二维码 -->
      <el-col :xs="24" :md="12">
        <el-card class="panel" shadow="never">
          <template #header>
            <div class="panel__header">
              <el-icon><EditPen /></el-icon>
              <span>文字 → 二维码</span>
            </div>
          </template>

          <el-input
            v-model="inputText"
            type="textarea"
            :rows="4"
            resize="none"
            placeholder="输入文字，自动生成二维码"
          />

          <div class="qr-preview">
            <canvas v-show="hasQr" ref="qrCanvas" class="qr-preview__canvas" />
            <el-empty
              v-show="!hasQr"
              description="输入内容后显示二维码"
              :image-size="80"
            />
          </div>

          <div class="panel__actions">
            <el-button :icon="'CopyDocument'" :disabled="!hasQr" @click="copyQrImage">
              复制图片
            </el-button>
            <el-button :icon="'Download'" :disabled="!hasQr" @click="saveQrImage">
              保存 PNG
            </el-button>
          </div>
        </el-card>
      </el-col>

      <!-- 右栏：二维码 -> 文字 -->
      <el-col :xs="24" :md="12">
        <el-card class="panel" shadow="never">
          <template #header>
            <div class="panel__header">
              <el-icon><Grid /></el-icon>
              <span>二维码 → 文字</span>
            </div>
          </template>

          <div class="panel__actions">
            <el-button type="primary" :icon="'Folder'" @click="onPickImage">
              选择图片
            </el-button>
            <el-button type="primary" :icon="'Camera'" @click="onCaptureScreen">
              屏幕截图
            </el-button>
            <el-button type="primary" :icon="'DocumentCopy'" @click="onReadClipboard">
              读取剪贴板
            </el-button>
          </div>

          <div
            class="drop-zone"
            :class="{ 'drop-zone--over': dragOver }"
            @dragover="onDragOver"
            @dragleave="onDragLeave"
            @drop="onDrop"
          >
            <el-icon :size="32"><UploadFilled /></el-icon>
            <p>拖拽图片到此处，或按 Ctrl+V 粘贴图片</p>
          </div>

          <div v-loading="decoding" class="decode-result">
            <template v-if="resultImage">
              <el-image
                class="decode-result__img"
                :src="resultImage"
                fit="contain"
                :preview-src-list="[resultImage]"
                preview-teleported
              />
              <div class="decode-result__text">
                <el-input
                  v-if="decodedText"
                  :model-value="decodedText"
                  type="textarea"
                  :rows="3"
                  readonly
                />
                <el-text v-else type="info">未识别到二维码内容</el-text>
                <el-button
                  v-if="decodedText"
                  class="decode-result__copy"
                  :icon="'CopyDocument'"
                  @click="copyDecodedText"
                >
                  复制文本
                </el-button>
              </div>
            </template>
            <el-empty v-else description="识别结果将显示在这里" :image-size="80" />
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 截图框选遮罩 -->
    <ScreenshotOverlay
      v-if="overlayImageUrl"
      :image-url="overlayImageUrl"
      @confirm="onOverlayConfirm"
      @cancel="onOverlayCancel"
    />
  </div>
</template>

<style scoped>
.qr-helper {
  max-width: 1100px;
  margin: 0 auto;
  padding: 24px;
}

.qr-helper__header {
  margin-bottom: 20px;
}

.qr-helper__title {
  font-size: 20px;
  font-weight: 600;
  color: #303133;
}

.panel {
  border-radius: 12px;
  margin-bottom: 20px;
  height: calc(100% - 20px);
}

.panel__header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: #303133;
}

.panel__actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin: 16px 0;
}

.qr-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 280px;
  background: #fafafa;
  border-radius: 8px;
}

.qr-preview__canvas {
  width: 260px;
  height: 260px;
}

.drop-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  border: 2px dashed #dcdfe6;
  border-radius: 8px;
  color: #909399;
  transition: all 0.2s;
}

.drop-zone p {
  margin: 0;
  font-size: 13px;
}

.drop-zone--over {
  border-color: #409eff;
  background: #ecf5ff;
  color: #409eff;
}

.decode-result {
  margin-top: 16px;
  min-height: 160px;
}

.decode-result__img {
  max-width: 160px;
  max-height: 160px;
  border-radius: 8px;
  border: 1px solid #ebeef5;
}

.decode-result__text {
  margin-top: 12px;
}

.decode-result__copy {
  margin-top: 8px;
}
</style>
