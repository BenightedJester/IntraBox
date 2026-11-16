import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import './style.css'
import App from './App.vue'
import router from './router'

// Cesium 静态资源（Workers / Assets / Widgets）基地址：
// 开发模式由 vite 中间件提供 /cesium，生产模式随 dist 打包经 /app/cesium 提供。
// 必须在创建 Cesium Viewer 之前设置。
window.CESIUM_BASE_URL = new URL('cesium/', document.baseURI).href

const app = createApp(App)

// 注册全部 element-plus 图标
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.use(router)
app.use(ElementPlus, { locale: zhCn })

app.mount('#app').$nextTick(() => {
  // Use contextBridge
  window.ipcRenderer.on('main-process-message', (_event, message) => {
    console.log(message)
  })
})
