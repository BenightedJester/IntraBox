<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'

const props = defineProps<{
  /** 全屏截图的 dataURL */
  imageUrl: string
}>()

const emit = defineEmits<{
  (e: 'confirm', dataUrl: string): void
  (e: 'cancel'): void
}>()

const imgRef = ref<HTMLImageElement>()
const selecting = ref(false)
const hasSelection = ref(false)
const startX = ref(0)
const startY = ref(0)
const rect = ref({ x: 0, y: 0, w: 0, h: 0 })

function onMouseDown(e: MouseEvent) {
  selecting.value = true
  hasSelection.value = false
  startX.value = e.clientX
  startY.value = e.clientY
  rect.value = { x: e.clientX, y: e.clientY, w: 0, h: 0 }
}

function onMouseMove(e: MouseEvent) {
  if (!selecting.value) return
  const x = Math.min(startX.value, e.clientX)
  const y = Math.min(startY.value, e.clientY)
  const w = Math.abs(e.clientX - startX.value)
  const h = Math.abs(e.clientY - startY.value)
  rect.value = { x, y, w, h }
}

function onMouseUp() {
  if (!selecting.value) return
  selecting.value = false
  if (rect.value.w < 5 || rect.value.h < 5) {
    // 选区过小视为无效，重置
    hasSelection.value = false
    return
  }
  hasSelection.value = true
  crop()
}

/** 按显示尺寸到原图尺寸的比例裁剪选区 */
function crop() {
  const img = imgRef.value
  if (!img) return
  const displayedW = window.innerWidth
  const displayedH = window.innerHeight
  const scaleX = img.naturalWidth / displayedW
  const scaleY = img.naturalHeight / displayedH

  const sx = Math.round(rect.value.x * scaleX)
  const sy = Math.round(rect.value.y * scaleY)
  const sw = Math.max(1, Math.round(rect.value.w * scaleX))
  const sh = Math.max(1, Math.round(rect.value.h * scaleY))

  const canvas = document.createElement('canvas')
  canvas.width = sw
  canvas.height = sh
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
  emit('confirm', canvas.toDataURL('image/png'))
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    emit('cancel')
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div
    class="screenshot-overlay"
    @mousedown="onMouseDown"
    @mousemove="onMouseMove"
    @mouseup="onMouseUp"
  >
    <img ref="imgRef" class="screenshot-overlay__bg" :src="props.imageUrl" alt="屏幕截图" draggable="false" />

    <!-- 选区之外的暗色遮罩（四块） -->
    <template v-if="hasSelection || selecting">
      <div class="mask mask--top" :style="{ height: rect.y + 'px' }" />
      <div
        class="mask mask--bottom"
        :style="{ top: rect.y + rect.h + 'px' }"
      />
      <div
        class="mask mask--left"
        :style="{ top: rect.y + 'px', height: rect.h + 'px', width: rect.x + 'px' }"
      />
      <div
        class="mask mask--right"
        :style="{ top: rect.y + 'px', height: rect.h + 'px', left: rect.x + rect.w + 'px' }"
      />
      <div
        class="selection-box"
        :style="{ left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px' }"
      />
    </template>

    <div class="screenshot-overlay__tip">拖拽框选二维码区域，Esc 取消</div>
  </div>
</template>

<style scoped>
.screenshot-overlay {
  position: fixed;
  inset: 0;
  z-index: 3000;
  cursor: crosshair;
  overflow: hidden;
  user-select: none;
}

.screenshot-overlay__bg {
  position: absolute;
  inset: 0;
  width: 100vw;
  height: 100vh;
  object-fit: fill;
  pointer-events: none;
}

.mask {
  position: absolute;
  background: rgba(0, 0, 0, 0.45);
  pointer-events: none;
}

.mask--top {
  top: 0;
  left: 0;
  width: 100%;
}

.mask--bottom {
  bottom: 0;
  left: 0;
  width: 100%;
}

.mask--left {
  left: 0;
}

.mask--right {
  right: 0;
}

.selection-box {
  position: absolute;
  border: 1px solid #409eff;
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0);
  pointer-events: none;
}

.screenshot-overlay__tip {
  position: absolute;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 16px;
  border-radius: 16px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 13px;
  pointer-events: none;
}
</style>
