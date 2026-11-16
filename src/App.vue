<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'
import { useLanStore } from './stores/lan'
import DownloadTray from './components/DownloadTray.vue'

const store = useLanStore()

// 全局拖拽保护：防止把文件拖到非接收区域时窗口直接导航打开文件
function prevent(e: DragEvent) {
  e.preventDefault()
}

onMounted(() => {
  void store.init()
  window.addEventListener('dragover', prevent)
  window.addEventListener('drop', prevent)
})

onBeforeUnmount(() => {
  window.removeEventListener('dragover', prevent)
  window.removeEventListener('drop', prevent)
})
</script>

<template>
  <!-- 浏览器直接访问（非 Electron）时，局域网 / 本地文件能力不可用 -->
  <div v-if="store.state.ready && !store.state.native" class="native-banner">
    当前在浏览器中预览：聊天、共享、本地文件等能力需要在桌面应用内使用
  </div>
  <router-view v-slot="{ Component }">
    <transition name="ib-page" mode="out-in">
      <component :is="Component" />
    </transition>
  </router-view>
  <DownloadTray v-if="store.state.native" />
</template>

<style scoped>
.native-banner {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 3000;
  padding: 7px 16px;
  text-align: center;
  font-size: 12.5px;
  color: #7a5b12;
  background: linear-gradient(90deg, #fdf3d7, #fbe8c0, #fdf3d7);
  border-bottom: 1px solid #f0d9a0;
}
</style>