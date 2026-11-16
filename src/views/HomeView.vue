<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useLanStore } from '../stores/lan'

interface Feature {
  key: string
  title: string
  desc: string
  route: string
  icon: string
  accent: string
  tags: string[]
}

const router = useRouter()
const store = useLanStore()
const { state } = store

const features: Feature[] = [
  {
    key: 'chat',
    title: '局域网聊天',
    desc: '和同一局域网里的伙伴即时聊天，拖拽即可发送文件，无需互联网',
    route: '/chat',
    icon: 'ChatDotRound',
    accent: 'var(--ib-cyan)',
    tags: ['自动发现邻居', '文件传输', '断线重发'],
  },
  {
    key: 'share',
    title: '共享文件夹',
    desc: '把文件夹一键共享给局域网邻居，也能浏览、下载对方共享的文件',
    route: '/share',
    icon: 'FolderOpened',
    accent: 'var(--ib-amber)',
    tags: ['一键共享', '邻居浏览', '高速下载'],
  },
  {
    key: 'model',
    title: '三维模型查看',
    desc: 'glTF / GLB / OBJ / FBX / STL / PLY / DAE，多文件外部资源自动解析',
    route: '/model-viewer',
    icon: 'Box',
    accent: 'var(--ib-violet)',
    tags: ['7 种格式', '离线解码', '动画播放'],
  },
  {
    key: 'tiles',
    title: '3D Tiles 查看',
    desc: '基于 Cesium 打开倾斜摄影、城市白模与点云，支持 URL 与局域网来源',
    route: '/tiles-viewer',
    icon: 'MapLocation',
    accent: 'var(--ib-green)',
    tags: ['Cesium 渲染', '离线地球', '白模样式'],
  },
  {
    key: 'qr-helper',
    title: '二维码助手',
    desc: '文字实时生成二维码，支持图片 / 截图 / 粘贴识别二维码',
    route: '/qr-helper',
    icon: 'Grid',
    accent: 'var(--ib-rose)',
    tags: ['实时生成', '截图识别', '剪贴板'],
  },
]

const statusChips = computed(() => [
  {
    key: 'service',
    label: state.self.running ? '服务运行中' : '服务已停止',
    online: state.self.running,
    route: '/chat',
  },
  {
    key: 'peers',
    label: `${state.peers.length} 台设备在线`,
    online: state.peers.length > 0,
    route: '/chat',
  },
  {
    key: 'shares',
    label: `${state.shares.filter((s) => s.enabled).length} 个共享中`,
    online: state.shares.some((s) => s.enabled),
    route: '/share',
  },
  {
    key: 'unread',
    label: store.totalUnread.value > 0 ? `${store.totalUnread.value} 条未读消息` : '没有未读消息',
    online: store.totalUnread.value > 0,
    route: '/chat',
  },
])

const selfLine = computed(() => {
  if (!state.self.name) return ''
  const ip = state.self.ips[0]
  return ip ? `${state.self.name} · ${ip}:${state.self.port}` : state.self.name
})

function open(feature: Feature) {
  router.push(feature.route)
}
function go(route: string) {
  router.push(route)
}
</script>

<template>
  <div class="home">
    <!-- 极光 hero -->
    <header class="hero ib-rise">
      <div class="hero__aurora" aria-hidden="true">
        <span class="blob blob--1" />
        <span class="blob blob--2" />
        <span class="blob blob--3" />
      </div>
      <div class="hero__content">
        <div class="hero__badge">要你命3000 · 离线可用</div>
        <h1 class="hero__title">要你命3000</h1>
        <p class="hero__subtitle">聊天 · 共享 · 三维查看 · 二维码 —— 同一局域网，开箱即用</p>
        <div class="hero__status">
          <button
            v-for="chip in statusChips"
            :key="chip.key"
            class="status-chip"
            @click="go(chip.route)"
          >
            <span :class="chip.online ? 'ib-online-dot' : 'ib-offline-dot'" />
            {{ chip.label }}
          </button>
        </div>
        <p v-if="selfLine" class="hero__self">{{ selfLine }}</p>
      </div>
    </header>

    <!-- 工具卡片 -->
    <div class="home__grid">
      <button
        v-for="(feature, i) in features"
        :key="feature.key"
        class="tool-card ib-rise"
        :style="{ '--accent': feature.accent, animationDelay: `${120 + i * 70}ms` }"
        @click="open(feature)"
      >
        <span class="tool-card__glow" aria-hidden="true" />
        <span class="tool-card__icon">
          <el-icon :size="26"><component :is="feature.icon" /></el-icon>
        </span>
        <span class="tool-card__body">
          <span class="tool-card__title">
            {{ feature.title }}
            <el-icon class="tool-card__arrow" :size="15"><ArrowRight /></el-icon>
          </span>
          <span class="tool-card__desc">{{ feature.desc }}</span>
          <span class="tool-card__tags">
            <i v-for="t in feature.tags" :key="t">{{ t }}</i>
          </span>
        </span>
      </button>
    </div>

    <footer class="home__footer">所有数据仅在本机与局域网内流转，不经过任何互联网服务器</footer>
  </div>
</template>

<style scoped>
.home {
  max-width: 1100px;
  margin: 0 auto;
  padding: 36px 24px 48px;
}

/* ---------- hero ---------- */
.hero {
  position: relative;
  border-radius: 22px;
  overflow: hidden;
  background: linear-gradient(135deg, #101736 0%, #0c1120 55%, #0a0e1a 100%);
  border: 1px solid rgba(122, 144, 210, 0.22);
  padding: 40px 40px 32px;
  margin-bottom: 26px;
}
.hero__aurora {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.blob {
  position: absolute;
  border-radius: 50%;
  filter: blur(60px);
  opacity: 0.5;
}
.blob--1 {
  width: 380px;
  height: 380px;
  left: -80px;
  top: -160px;
  background: radial-gradient(circle, rgba(79, 107, 255, 0.75), transparent 70%);
  animation: drift1 11s ease-in-out infinite alternate;
}
.blob--2 {
  width: 320px;
  height: 320px;
  right: -40px;
  top: -120px;
  background: radial-gradient(circle, rgba(23, 195, 230, 0.55), transparent 70%);
  animation: drift2 13s ease-in-out infinite alternate;
}
.blob--3 {
  width: 300px;
  height: 300px;
  right: 22%;
  bottom: -180px;
  background: radial-gradient(circle, rgba(145, 99, 255, 0.5), transparent 70%);
  animation: drift3 15s ease-in-out infinite alternate;
}
@keyframes drift1 {
  to { transform: translate(70px, 40px) scale(1.12); }
}
@keyframes drift2 {
  to { transform: translate(-60px, 50px) scale(0.92); }
}
@keyframes drift3 {
  to { transform: translate(-90px, -30px) scale(1.15); }
}
.hero__content {
  position: relative;
  z-index: 1;
}
.hero__badge {
  display: inline-block;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 2px;
  color: #aebaff;
  border: 1px solid rgba(125, 144, 255, 0.4);
  background: rgba(79, 107, 255, 0.14);
  padding: 4px 12px;
  border-radius: 20px;
  margin-bottom: 14px;
}
.hero__title {
  margin: 0;
  font-size: 38px;
  font-weight: 800;
  letter-spacing: 1px;
  color: #f0f3ff;
}
.hero__subtitle {
  margin: 8px 0 20px;
  font-size: 14.5px;
  color: #9aa6c8;
}
.hero__status {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.status-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 1px solid rgba(122, 144, 210, 0.28);
  background: rgba(12, 17, 32, 0.55);
  backdrop-filter: blur(6px);
  color: #c6cfea;
  font-size: 12.5px;
  font-family: inherit;
  padding: 7px 14px;
  border-radius: 20px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, transform 0.15s;
}
.status-chip:hover {
  border-color: rgba(125, 144, 255, 0.6);
  background: rgba(79, 107, 255, 0.16);
  transform: translateY(-1px);
}
.hero__self {
  margin: 16px 0 0;
  font-size: 11.5px;
  color: #5f6b8c;
}

/* ---------- 工具卡片 ---------- */
.home__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(310px, 1fr));
  gap: 18px;
}
.tool-card {
  position: relative;
  display: flex;
  gap: 16px;
  text-align: left;
  padding: 22px;
  border-radius: 16px;
  border: 1px solid var(--ib-border);
  background: var(--ib-surface);
  cursor: pointer;
  font-family: inherit;
  overflow: hidden;
  transition: transform 0.2s, border-color 0.2s, box-shadow 0.2s;
}
.tool-card:hover {
  transform: translateY(-4px);
  border-color: var(--accent);
  box-shadow: 0 14px 34px -14px color-mix(in srgb, var(--accent) 45%, transparent);
}
.tool-card__glow {
  position: absolute;
  right: -60px;
  top: -60px;
  width: 160px;
  height: 160px;
  border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--accent) 16%, transparent), transparent 70%);
  pointer-events: none;
  transition: opacity 0.2s;
  opacity: 0.7;
}
.tool-card:hover .tool-card__glow {
  opacity: 1;
}
.tool-card__icon {
  flex-shrink: 0;
  width: 54px;
  height: 54px;
  border-radius: 15px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 62%, #1c2333));
  box-shadow: 0 8px 18px -8px color-mix(in srgb, var(--accent) 70%, transparent);
}
.tool-card__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tool-card__title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 16.5px;
  font-weight: 700;
  color: var(--ib-ink);
}
.tool-card__arrow {
  color: var(--accent);
  opacity: 0;
  transform: translateX(-4px);
  transition: opacity 0.2s, transform 0.2s;
}
.tool-card:hover .tool-card__arrow {
  opacity: 1;
  transform: translateX(0);
}
.tool-card__desc {
  font-size: 12.8px;
  line-height: 1.55;
  color: var(--ib-ink-2);
}
.tool-card__tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 4px;
}
.tool-card__tags i {
  font-style: normal;
  font-size: 11px;
  color: var(--ib-ink-2);
  background: var(--ib-surface-2);
  border: 1px solid var(--ib-border);
  padding: 2px 9px;
  border-radius: 12px;
}

.home__footer {
  margin-top: 30px;
  text-align: center;
  font-size: 12px;
  color: var(--ib-ink-3);
}
</style>