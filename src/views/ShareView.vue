<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import LanFileBrowser from '../components/LanFileBrowser.vue'
import { useLanStore } from '../stores/lan'
import { copyText } from '../utils/format'
import { isModelFile, isTilesetFile, type ShareInfo } from '../shared/lan-types'

const router = useRouter()
const store = useLanStore()
const { state } = store

const tab = ref<'neighbors' | 'mine'>('neighbors')
const renameDialog = ref(false)
const renameTarget = ref<ShareInfo | null>(null)
const renameInput = ref('')
const adding = ref(false)

const enabledCount = computed(() => state.shares.filter((s) => s.enabled).length)

async function addShare() {
  adding.value = true
  try {
    const res = await window.api.shares.add()
    if (res) ElMessage.success('共享已添加，邻居即可浏览')
  } catch (err) {
    ElMessage.error('添加失败：' + String(err))
  } finally {
    adding.value = false
  }
}

async function removeShare(share: ShareInfo) {
  try {
    await ElMessageBox.confirm(
      `移除共享「${share.name}」？邻居将无法再访问该文件夹（本地文件不会被删除）。`,
      '移除共享',
      { type: 'warning', confirmButtonText: '移除', cancelButtonText: '取消' },
    )
    await window.api.shares.remove(share.id)
    ElMessage.success('已移除共享')
  } catch {
    /* 取消 */
  }
}

async function toggleShare(share: ShareInfo, enabled: boolean) {
  await window.api.shares.toggle(share.id, enabled)
}

function openRename(share: ShareInfo) {
  renameTarget.value = share
  renameInput.value = share.name
  renameDialog.value = true
}

async function saveRename() {
  if (!renameTarget.value || !renameInput.value.trim()) return
  await window.api.shares.rename(renameTarget.value.id, renameInput.value.trim())
  renameDialog.value = false
}

async function copyShareUrl(share: ShareInfo) {
  const url = await window.api.shares.url(share.id)
  if (await copyText(url)) ElMessage.success('共享根地址已复制')
  else ElMessage.error('复制失败')
}

function onShareCommand(cmd: string, share: ShareInfo) {
  if (cmd === 'rename') openRename(share)
  else if (cmd === 'reveal') void window.api.shares.reveal(share.id)
  else if (cmd === 'copy') void copyShareUrl(share)
  else if (cmd === 'remove') void removeShare(share)
}

async function onOpenFile(payload: { peerId: string; shareId: string; shareName: string; relPath: string; name: string }) {
  // 根据文件类型跳转到对应查看器
  if (isModelFile(payload.name)) {
    const source = await window.api.source.fromShare(payload.peerId, payload.shareId, payload.relPath, payload.shareName)
    store.requestOpen({ viewer: 'model', source })
    router.push('/model-viewer')
  } else if (isTilesetFile(payload.name)) {
    const source = await window.api.source.fromShare(payload.peerId, payload.shareId, payload.relPath, payload.shareName)
    store.requestOpen({ viewer: 'tiles', source })
    router.push('/tiles-viewer')
  } else {
    // 其它文件：下载
    const peer = store.peerById(payload.peerId)
    if (!peer) return
    const url = `http://${peer.ip}:${peer.port}/share/${payload.shareId}/fs/${payload.relPath.split('/').map(encodeURIComponent).join('/')}`
    await store.startDownload(url, payload.name, true)
  }
}
</script>

<template>
  <div class="share">
    <el-page-header class="ib-page-header" @back="router.back()">
      <template #content>
        <span class="ib-page-title">共享文件夹</span>
        <span class="ib-page-sub">把本机文件夹分享给邻居，或浏览他人的共享</span>
      </template>
      <template #extra>
        <el-tag v-if="state.self.running" type="success" effect="light" round>
          <span class="ib-online-dot" style="display: inline-block; margin-right: 6px" />
          服务运行中 · 端口 {{ state.self.port }}
        </el-tag>
        <el-tag v-else type="info" effect="light" round>服务已停止</el-tag>
      </template>
    </el-page-header>

    <el-tabs v-model="tab" class="share__tabs">
      <!-- 邻居文件 -->
      <el-tab-pane name="neighbors">
        <template #label>
          <span class="tab-label"><el-icon><Connection /></el-icon> 邻居文件</span>
        </template>
        <div class="share__browser ib-panel">
          <LanFileBrowser filter="any" @open-file="onOpenFile" />
        </div>
        <p class="share__tip">
          双击文件夹进入，双击模型 / tileset.json 直接在查看器中打开；其它文件可下载或复制直链。
        </p>
      </el-tab-pane>

      <!-- 我的共享 -->
      <el-tab-pane name="mine">
        <template #label>
          <span class="tab-label"><el-icon><FolderOpened /></el-icon> 我的共享 · {{ enabledCount }}</span>
        </template>

        <div class="mine-head">
          <p class="mine-head__note">
            只有你主动添加的文件夹才会对邻居可见，随时可关闭或移除。
          </p>
          <el-button type="primary" :icon="'Plus'" :loading="adding" @click="addShare">添加共享文件夹</el-button>
        </div>

        <el-empty v-if="state.shares.length === 0" description="还没有共享任何文件夹" :image-size="90">
          <el-button type="primary" :icon="'Plus'" @click="addShare">添加第一个共享</el-button>
        </el-empty>

        <div v-else class="share-grid">
          <div v-for="share in state.shares" :key="share.id" class="share-card" :class="{ 'share-card--off': !share.enabled }">
            <div class="share-card__icon">
              <el-icon :size="24"><Folder /></el-icon>
            </div>
            <div class="share-card__body">
              <div class="share-card__name" :title="share.name">{{ share.name }}</div>
              <div class="share-card__path" :title="share.path">{{ share.path }}</div>
            </div>
            <el-switch
              :model-value="share.enabled"
              size="small"
              @change="toggleShare(share, Boolean($event))"
            />
            <el-dropdown trigger="click" @command="(cmd: string) => onShareCommand(cmd, share)">
              <el-button :icon="'MoreFilled'" circle size="small" text />
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="rename" :icon="'EditPen'">重命名</el-dropdown-item>
                  <el-dropdown-item command="reveal" :icon="'FolderOpened'">打开本地文件夹</el-dropdown-item>
                  <el-dropdown-item command="copy" :icon="'Link'">复制共享地址</el-dropdown-item>
                  <el-dropdown-item command="remove" :icon="'Delete'" divided>移除共享</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="renameDialog" title="重命名共享" width="380px">
      <el-input v-model="renameInput" maxlength="40" placeholder="共享显示名称" @keyup.enter="saveRename" />
      <template #footer>
        <el-button @click="renameDialog = false">取消</el-button>
        <el-button type="primary" @click="saveRename">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.share {
  max-width: 1180px;
  margin: 0 auto;
  padding: 22px 24px;
  height: 100vh;
  display: flex;
  flex-direction: column;
}

.share__tabs {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.share__tabs :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
}
.share__tabs :deep(.el-tab-pane) {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.tab-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}

.share__browser {
  flex: 1;
  min-height: 0;
  padding: 16px;
}
.share__tip {
  margin: 10px 2px 0;
  font-size: 12px;
  color: var(--ib-ink-3);
}

.mine-head {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
}
.mine-head__note {
  flex: 1;
  margin: 0;
  font-size: 13px;
  color: var(--ib-ink-2);
}

.share-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 14px;
  overflow-y: auto;
  padding-bottom: 12px;
}

.share-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 14px;
  background: var(--ib-surface);
  border: 1px solid var(--ib-border);
  transition: all 0.18s;
}
.share-card:hover {
  border-color: #f0c987;
  box-shadow: 0 6px 20px rgba(245, 165, 36, 0.12);
  transform: translateY(-2px);
}
.share-card--off {
  opacity: 0.6;
}
.share-card__icon {
  width: 46px;
  height: 46px;
  border-radius: 12px;
  background: linear-gradient(135deg, #f5a524, #f7c948);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.share-card__body {
  flex: 1;
  min-width: 0;
}
.share-card__name {
  font-weight: 700;
  font-size: 14px;
  color: var(--ib-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.share-card__path {
  font-size: 11.5px;
  color: var(--ib-ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 2px;
}
</style>