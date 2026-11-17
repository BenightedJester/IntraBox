<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { AppSettingsView, CloseAction } from '../shared/lan-types'

const router = useRouter()

const native = typeof window !== 'undefined' && !!window.api
const loading = ref(true)
const closeAction = ref<CloseAction>('ask')
const autoStart = ref(false)
const autoStartSupported = ref(false)
const isPortable = ref(false)

onMounted(async () => {
  if (!native) {
    loading.value = false
    return
  }
  try {
    const s: AppSettingsView = await window.api.settings.get()
    closeAction.value = s.closeAction
    autoStart.value = s.autoStart
    autoStartSupported.value = s.autoStartSupported
    isPortable.value = s.isPortable
  } catch (err) {
    ElMessage.error('读取设置失败：' + (err as Error).message)
  } finally {
    loading.value = false
  }
})

async function onCloseChange(val: string | number | boolean) {
  try {
    await window.api.settings.setCloseAction(val as CloseAction)
    ElMessage.success('关闭行为已更新')
  } catch (err) {
    ElMessage.error('保存失败：' + (err as Error).message)
  }
}

async function onAutoStartChange(val: boolean) {
  try {
    autoStart.value = await window.api.settings.setAutoStart(val)
    ElMessage.success(autoStart.value ? '已开启开机自启' : '已关闭开机自启')
  } catch (err) {
    autoStart.value = !val
    ElMessage.error((err as Error).message)
  }
}

function goBack() {
  router.back()
}
</script>

<template>
  <div class="settings">
    <el-page-header class="settings__header" @back="goBack">
      <template #content>
        <span class="settings__title">设置</span>
      </template>
    </el-page-header>

    <el-card v-loading="loading" class="panel" shadow="never">
      <template #header>
        <div class="panel__header">
          <el-icon><Setting /></el-icon>
          <span>通用</span>
        </div>
      </template>

      <div class="setting-item">
        <div class="setting-item__text">
          <div class="setting-item__label">关闭主窗口时</div>
          <div class="setting-item__desc">
            选择「每次询问」时，关闭前会弹窗让你选择隐藏到托盘还是退出；勾选「记住选择」后按所选行为直接执行
          </div>
        </div>
        <el-radio-group v-model="closeAction" :disabled="!native" @change="onCloseChange">
          <el-radio value="ask">每次询问</el-radio>
          <el-radio value="hide">隐藏到托盘</el-radio>
          <el-radio value="quit">直接退出</el-radio>
        </el-radio-group>
      </div>

      <el-divider />

      <div class="setting-item">
        <div class="setting-item__text">
          <div class="setting-item__label">开机自启</div>
          <div class="setting-item__desc">
            登录系统后自动启动本应用（默认关闭）
            <template v-if="!native">；浏览器预览中不可用</template>
            <template v-else-if="!autoStartSupported">；开发模式下不可用，打包后生效</template>
            <template v-else-if="isPortable">
              ；便携版移动 exe 位置后，下次启动会自动更新自启路径
            </template>
          </div>
        </div>
        <el-switch
          v-model="autoStart"
          :disabled="!native || !autoStartSupported"
          @change="onAutoStartChange"
        />
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.settings {
  max-width: 860px;
  margin: 0 auto;
  padding: 24px;
}
.settings__header {
  margin-bottom: 20px;
}
.settings__title {
  font-size: 17px;
  font-weight: 700;
  color: var(--ib-ink);
}
.panel__header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: var(--ib-ink);
}
.setting-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 6px 2px;
}
.setting-item__text {
  flex: 1;
  min-width: 0;
}
.setting-item__label {
  font-size: 14.5px;
  font-weight: 600;
  color: var(--ib-ink);
}
.setting-item__desc {
  margin-top: 4px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ib-ink-2);
}
</style>