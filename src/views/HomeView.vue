<script setup lang="ts">
import { useRouter } from 'vue-router'
import { Grid } from '@element-plus/icons-vue'

interface Feature {
  key: string
  title: string
  desc: string
  route: string
  icon: unknown
}

const router = useRouter()

// 目前仅有一个功能，后续可在此数组中继续扩展
const features: Feature[] = [
  {
    key: 'qr-helper',
    title: '二维码助手',
    desc: '文字实时生成二维码，支持图片 / 截图 / 粘贴识别二维码',
    route: '/qr-helper',
    icon: Grid,
  },
]

function open(feature: Feature) {
  router.push(feature.route)
}
</script>

<template>
  <div class="home">
    <header class="home__header">
      <h1 class="home__title">内网工具箱</h1>
      <p class="home__subtitle">实用小工具合集</p>
    </header>

    <el-row class="home__grid" :gutter="20">
      <el-col
        v-for="feature in features"
        :key="feature.key"
        :xs="24"
        :sm="12"
        :md="8"
        :lg="6"
      >
        <el-card
          class="feature-card"
          shadow="hover"
          @click="open(feature)"
        >
          <div class="feature-card__body">
            <el-icon class="feature-card__icon" :size="40">
              <component :is="feature.icon" />
            </el-icon>
            <div class="feature-card__text">
              <h3 class="feature-card__title">{{ feature.title }}</h3>
              <p class="feature-card__desc">{{ feature.desc }}</p>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.home {
  max-width: 1100px;
  margin: 0 auto;
  padding: 48px 24px;
}

.home__header {
  text-align: center;
  margin-bottom: 40px;
}

.home__title {
  margin: 0;
  font-size: 40px;
  font-weight: 700;
  letter-spacing: 1px;
  color: #303133;
}

.home__subtitle {
  margin: 8px 0 0;
  color: #909399;
  font-size: 15px;
}

.home__grid {
  justify-content: center;
}

.feature-card {
  cursor: pointer;
  margin-bottom: 20px;
  border-radius: 12px;
  transition: transform 0.2s;
}

.feature-card:hover {
  transform: translateY(-4px);
}

.feature-card__body {
  display: flex;
  align-items: center;
  gap: 16px;
}

.feature-card__icon {
  color: #409eff;
  flex-shrink: 0;
}

.feature-card__title {
  margin: 0 0 6px;
  font-size: 17px;
  font-weight: 600;
  color: #303133;
}

.feature-card__desc {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: #909399;
}
</style>
