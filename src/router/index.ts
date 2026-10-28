import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: () => import('../views/HomeView.vue'),
    meta: { title: '内网工具箱' },
  },
  {
    path: '/qr-helper',
    name: 'qr-helper',
    component: () => import('../views/QrHelperView.vue'),
    meta: { title: '二维码助手' },
  },
]

const router = createRouter({
  // Electron 打包后以 file:// 加载，使用 hash 模式更稳妥
  history: createWebHashHistory(),
  routes,
})

export default router
