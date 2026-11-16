<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import LanFileBrowser from './LanFileBrowser.vue'
import type { ViewerSource } from '../shared/lan-types'

/**
 * “从局域网打开”对话框：浏览邻居共享并构造查看器数据源。
 * 选中文件后调用主进程 source:from-share（附带文件索引）。
 */
defineProps<{
  modelValue: boolean
  filter: 'model' | 'tiles'
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'open', source: ViewerSource): void
}>()

const loading = ref(false)

async function onOpenFile(payload: { peerId: string; shareId: string; shareName: string; relPath: string; name: string }) {
  loading.value = true
  try {
    const source = await window.api.source.fromShare(payload.peerId, payload.shareId, payload.relPath, payload.shareName)
    emit('open', source)
    emit('update:modelValue', false)
  } catch (err) {
    ElMessage.error('打开失败：' + String(err))
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="filter === 'model' ? '从局域网共享打开模型' : '从局域网共享打开 3D Tiles'"
    width="860px"
    top="6vh"
    class="ib-dark lan-open-dialog"
    append-to-body
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-loading="loading" class="lan-open-dialog__body">
      <LanFileBrowser :filter="filter" @open-file="onOpenFile" />
    </div>
    <template #footer>
      <span class="lan-open-dialog__hint">
        {{ filter === 'model' ? '支持 gltf / glb / obj / fbx / stl / ply / dae，外部资源自动解析' : '选择 tileset.json 入口文件' }}
      </span>
      <el-button @click="emit('update:modelValue', false)">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.lan-open-dialog__body {
  height: 520px;
}
.lan-open-dialog__hint {
  float: left;
  font-size: 12px;
  color: var(--ib-space-ink-3);
  line-height: 32px;
}
</style>

<style>
.lan-open-dialog .el-dialog__body {
  padding-top: 8px;
}
</style>