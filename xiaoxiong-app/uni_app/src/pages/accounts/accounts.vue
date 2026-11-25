<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { t } from '@/core/i18n'
import {
  listAccounts, createAccount, updateAccount, removeAccount,
  type AccountView, type AccountKind, type AccountInput,
} from '@/core/transport/accountApi'
import { useSubPageBack } from '@/core/composables/useSubPageBack'
import SubPageNav from '@/components/SubPageNav.vue'
import { useThemeStyle } from '@/core/composables/useTheme'

/**
 * 通用账号本：按用户自定义的 type（通常等于工具名前缀，如 askdata）保存凭据。
 * kind=password 用账号+密码；kind=apikey 用 API Key。列表不回显凭据明文，
 * 编辑时若不重新输入凭据则保留原值（留空=不改动）。
 */
const { themeStyle, dataTheme } = useThemeStyle()
const { goBack } = useSubPageBack({ fallbackUrl: '/pages/settings/settings' })

const loading = ref(true)
const error = ref('')
const accounts = ref<AccountView[]>([])

// 编辑弹窗状态：editing=null 新增；editing=id 编辑
const showEditor = ref(false)
const editingId = ref<number | null>(null)
const form = ref({ type: '', name: '', kind: 'password' as AccountKind, username: '', password: '', apiKey: '', note: '' })
const saving = ref(false)
const formError = ref('')

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    accounts.value = await listAccounts()
  } catch (e: any) {
    error.value = e?.message ?? t('accounts.loadFail')
  } finally {
    loading.value = false
  }
}

function openCreate(): void {
  editingId.value = null
  form.value = { type: '', name: '', kind: 'password', username: '', password: '', apiKey: '', note: '' }
  formError.value = ''
  showEditor.value = true
}

function openEdit(a: AccountView): void {
  editingId.value = a.id
  form.value = {
    type: a.type, name: a.name, kind: a.kind, username: a.username,
    password: '', apiKey: '', note: a.note,
  }
  formError.value = ''
  showEditor.value = true
}

function closeEditor(): void {
  showEditor.value = false
}

function kindLabel(kind: AccountKind): string {
  return kind === 'apikey' ? t('accounts.kindApikey') : t('accounts.kindPassword')
}

async function save(): Promise<void> {
  const f = form.value
  if (!f.type.trim()) { formError.value = t('accounts.typeRequired'); return }
  if (f.kind === 'password' && editingId.value === null && !f.password) {
    formError.value = t('accounts.passwordRequired'); return
  }
  if (f.kind === 'apikey' && editingId.value === null && !f.apiKey) {
    formError.value = t('accounts.apiKeyRequired'); return
  }
  saving.value = true
  formError.value = ''
  const input: AccountInput = {
    type: f.type.trim(), name: f.name.trim(), kind: f.kind,
    username: f.username.trim(), note: f.note.trim(),
  }
  // 留空=不改动凭据（编辑时保留原值）
  if (f.password) input.password = f.password
  if (f.apiKey) input.apiKey = f.apiKey
  try {
    if (editingId.value === null) await createAccount(input)
    else await updateAccount(editingId.value, input)
    closeEditor()
    await load()
  } catch (e: any) {
    formError.value = e?.message ?? t('accounts.saveFail')
  } finally {
    saving.value = false
  }
}

function remove(a: AccountView): void {
  uni.showModal({
    title: t('accounts.delete'),
    content: t('accounts.deleteConfirm', { name: a.name || a.type }),
    success: (res) => {
      if (res.confirm) void removeAccount(a.id).then(load).catch((e) => { error.value = e?.message ?? t('accounts.deleteFail') })
    },
  })
}

onMounted(() => { void load() })
</script>

<template>
  <view class="page" :style="themeStyle" :data-theme="dataTheme">
    <SubPageNav :title="t('accounts.title')" @back="goBack" />

    <view class="head">
      <text class="sub">{{ t('accounts.sub') }}</text>
      <text class="add" @tap="openCreate">{{ t('accounts.add') }}</text>
    </view>

    <text v-if="loading" class="state">{{ t('accounts.loading') }}</text>
    <text v-else-if="error" class="state state-err">{{ error }}</text>
    <text v-else-if="!accounts.length" class="state">{{ t('accounts.empty') }}</text>

    <view v-else class="list">
      <view v-for="a in accounts" :key="a.id" class="card">
        <view class="card-main">
          <view class="card-head">
            <text class="card-type">{{ a.type }}</text>
            <text class="badge">{{ kindLabel(a.kind) }}</text>
          </view>
          <text v-if="a.name" class="card-name">{{ a.name }}</text>
          <text v-if="a.username" class="card-user">{{ a.username }}</text>
          <text v-if="a.note" class="card-note">{{ a.note }}</text>
          <text class="card-secret">{{ a.hasSecret ? t('accounts.hasSecret') : t('accounts.noSecret') }}</text>
        </view>
        <view class="card-actions">
          <text class="act" @tap="openEdit(a)">{{ t('accounts.edit') }}</text>
          <text class="act act-del" @tap="remove(a)">{{ t('accounts.delete') }}</text>
        </view>
      </view>
    </view>

    <!-- 新增/编辑弹窗 -->
    <view v-if="showEditor" class="mask" @tap="closeEditor">
      <view class="dialog" @tap.stop>
        <text class="dialog-title">{{ editingId === null ? t('accounts.add') : t('accounts.edit') }}</text>

        <text class="label">{{ t('accounts.type') }}</text>
        <input class="input" v-model="form.type" :placeholder="t('accounts.typePlaceholder')" />
        <text class="hint">{{ t('accounts.typeHint') }}</text>

        <text class="label">{{ t('accounts.name') }}</text>
        <input class="input" v-model="form.name" :placeholder="t('accounts.namePlaceholder')" />

        <text class="label">{{ t('accounts.kind') }}</text>
        <view class="kind-row">
          <text class="kind" :class="{ on: form.kind === 'password' }" @tap="form.kind = 'password'">{{ t('accounts.kindPassword') }}</text>
          <text class="kind" :class="{ on: form.kind === 'apikey' }" @tap="form.kind = 'apikey'">{{ t('accounts.kindApikey') }}</text>
        </view>

        <template v-if="form.kind === 'password'">
          <text class="label">{{ t('accounts.username') }}</text>
          <input class="input" v-model="form.username" :placeholder="t('accounts.usernamePlaceholder')" />
          <text class="label">{{ t('accounts.password') }}</text>
          <input class="input" password v-model="form.password" :placeholder="editingId === null ? t('accounts.passwordPlaceholder') : t('accounts.passwordKeep')" />
        </template>
        <template v-else>
          <text class="label">{{ t('accounts.apiKey') }}</text>
          <input class="input" password v-model="form.apiKey" :placeholder="editingId === null ? t('accounts.apiKeyPlaceholder') : t('accounts.apiKeyKeep')" />
        </template>

        <text class="label">{{ t('accounts.note') }}</text>
        <input class="input" v-model="form.note" :placeholder="t('accounts.notePlaceholder')" />

        <text v-if="formError" class="form-err">{{ formError }}</text>

        <view class="dialog-actions">
          <text class="btn btn-cancel" @tap="closeEditor">{{ t('accounts.cancel') }}</text>
          <text class="btn btn-save" :class="{ disabled: saving }" @tap="save">{{ saving ? t('accounts.saving') : t('accounts.save') }}</text>
        </view>
      </view>
    </view>
  </view>
</template>

<style scoped>
.page {
  min-height: 100vh;
  padding: 0 16px calc(32px + env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  gap: 14px;
  background: radial-gradient(120% 50% at 50% 0%, var(--bg-glow), transparent 60%), var(--bg-base);
}
.head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.sub { font-size: 12px; line-height: 1.5; color: #6f7691; flex: 1; }
.add { font-size: 13px; color: var(--accent); flex-shrink: 0; }
.state { font-size: 13px; line-height: 1.6; color: #9aa0bd; padding: 24px 4px; }
.state-err { color: #ff8a8a; }
.list { display: flex; flex-direction: column; gap: 10px; }
.card {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 12px 14px; border-radius: 14px;
  background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.07);
}
.card-main { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
.card-head { display: flex; align-items: center; gap: 8px; }
.card-type { font-size: 14px; color: #9be8cd; }
.badge { font-size: 11px; color: #9aa0bd; background: rgba(255,255,255,0.06); border-radius: 8px; padding: 1px 6px; }
.card-name { font-size: 13px; color: #e8eaf6; }
.card-user { font-size: 12px; color: #9aa0bd; }
.card-note { font-size: 11px; color: #6f7691; }
.card-secret { font-size: 11px; color: #6f7691; }
.card-actions { display: flex; gap: 12px; flex-shrink: 0; }
.act { font-size: 13px; color: var(--accent); }
.act-del { color: #ff8a8a; }
.mask { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 100; }
.dialog {
  width: 86%; max-height: 86vh; overflow-y: auto;
  display: flex; flex-direction: column; gap: 6px;
  padding: 18px; border-radius: 16px; background: var(--bg-base);
  border: 1px solid rgba(255,255,255,0.1);
}
.dialog-title { font-size: 16px; color: #9be8cd; margin-bottom: 6px; }
.label { font-size: 12px; color: #9aa0bd; margin-top: 6px; }
.input {
  height: 38px; padding: 0 10px; border-radius: 8px;
  background: rgba(255,255,255,0.06); color: #e8eaf6; font-size: 13px;
  border: 1px solid rgba(255,255,255,0.1);
}
.hint { font-size: 11px; color: #6f7691; }
.kind-row { display: flex; gap: 8px; }
.kind { font-size: 12px; color: #9aa0bd; padding: 6px 12px; border-radius: 8px; background: rgba(255,255,255,0.05); }
.kind.on { color: #9be8cd; background: rgba(108,140,255,0.2); }
.form-err { font-size: 12px; color: #ff8a8a; margin-top: 4px; }
.dialog-actions { display: flex; gap: 10px; margin-top: 14px; }
.btn { flex: 1; text-align: center; padding: 10px 0; border-radius: 10px; font-size: 13px; }
.btn-cancel { color: #9aa0bd; background: rgba(255,255,255,0.06); }
.btn-save { color: #fff; background: var(--accent); }
.btn.disabled { opacity: 0.6; }
</style>
