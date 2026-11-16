import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: () => import('../views/HomeView.vue'),
    meta: { title: '要你命3000' },
  },
  {
    path: '/qr-helper',
    name: 'qr-helper',
    component: () => import('../views/QrHelperView.vue'),
    meta: { title: '二维码助手' },
  },
  {
    path: '/chat',
    name: 'chat',
    component: () => import('../views/ChatView.vue'),
    meta: { title: '局域网聊天' },
  },
  {
    path: '/share',
    name: 'share',
    component: () => import('../views/ShareView.vue'),
    meta: { title: '共享文件夹' },
  },
  {
    path: '/model-viewer',
    name: 'model-viewer',
    component: () => import('../views/ModelViewerView.vue'),
    meta: { title: '三维模型查看' },
  },
  {
    path: '/tiles-viewer',
    name: 'tiles-viewer',
    component: () => import('../views/TilesViewerView.vue'),
    meta: { title: '3D Tiles 查看' },
  },
]

const router = createRouter({
  // 生产模式经 http://127.0.0.1:<port>/app/ 加载，hash 模式避免服务端路由配置
  history: createWebHashHistory(),
  routes,
})

router.afterEach((to) => {
  const title = (to.meta.title as string) || '要你命3000'
  document.title = to.name === 'home' ? title : `${title} · 要你命3000`
})

export default router
