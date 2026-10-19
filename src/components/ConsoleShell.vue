<template>
  <div class="container-wide">
    <div class="console">
      <aside class="console-side">
        <div class="org">
          <!-- 后端账号投影无机构名（B2 契约）⇒ 依次回落到邮箱 / 手机号，绝不显示假机构名 -->
          <b>{{ user?.orgName || user?.email || user?.phone || '（未登录）' }}</b>
          <!-- §1.3 04-1：套餐档位归属**顶栏**（D6）；侧栏只保留机构名与账期，不重复档位 -->
          <span>账期 {{ account.data.value?.monthKey || '—' }}</span>
        </div>
        <nav class="side-nav" aria-label="控制台导航">
          <router-link v-for="item in navItems" :key="item.to" :to="item.to">{{ item.label }}</router-link>
          <!-- §1.6 导航骨架：控制台侧栏 M2/M3 入口 —— 指向营销站同一份页面（同域跳转），不重复实现 -->
          <a v-for="item in externalItems" :key="item.href" :href="item.href" class="pending">
            {{ item.label }}<i>即将开放</i>
          </a>
          <!-- §1.3 P-M1-08 交互 4：控制台侧栏「计费规则」指向营销站同一页面，不重复实现第二份规则页 -->
          <a href="/pricing">计费规则</a>
        </nav>
        <div class="side-foot">
          <template v-if="isMock">
            演示环境 · 示例数据<br />
            金额与用量均为界面示意值<br />
          </template>
          <template v-else>
            真实账号环境<br />
            密钥与用量取自服务端<br />
          </template>
          {{ stateNote }}
        </div>
      </aside>

      <section class="console-main">
        <div class="console-top">
          <span class="crumb">{{ crumb }}</span>
          <!-- 页面标识仅作开发期留痕，**不渲染到界面**（内部编号不对客暴露）：{{ specRef }} -->
          <div class="top-user">
            <!-- §1.3 04-1：顶栏含「当前用户、套餐档位、退出」（D6：档位归属顶栏） -->
            <span class="top-plan"><i>套餐档位</i>{{ planName }}</span>
            <span>{{ user?.email || '—' }}</span>
            <button class="btn ghost sm" type="button" @click="handleSignOut">退出</button>
          </div>
        </div>

        <slot />

        <div v-if="disclaimer" class="disclaimer" style="margin-top:24px;border-top:1px solid var(--line);padding-top:12px;">
          {{ disclaimer }}
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { getAccount, getAppConfig, getPricingTable, RESOLVED_DATA_SOURCE } from '@/data'
import { useAsync } from '@/composables/useAsync.js'
import { useAuth } from '@/composables/useAuth.js'

defineProps({
  crumb: { type: String, default: '控制台' },
  specRef: { type: String, default: '' },
})

const router = useRouter()
const { user, signOut } = useAuth()
/** §4.3：外壳也不得直接读配置模块，一律经适配层（A1 / A15 / A17）。 */
const appConfig = useAsync(getAppConfig, { immediate: true })
const table = useAsync(getPricingTable, { immediate: true })
const account = useAsync(getAccount, { immediate: true })

/**
 * **生效数据源**（角标与脚注的唯一判据）：
 *   ① 优先取 A1 `config.dataSource`（服务端自报，`api` 模式恒为 `api`）；
 *   ② 未取到（加载中 / 读取失败 / 旧实现未给该字段）⇒ 回落构建期单一开关 `RESOLVED_DATA_SOURCE`。
 * 目的：api 模式下**不得**再出现「演示数据 / 示例数据 / 界面示意值」这类与事实相反的声明。
 */
const dataSource = computed(() => appConfig.data.value?.dataSource || RESOLVED_DATA_SOURCE)
const isMock = computed(() => dataSource.value === 'mock')

const planName = computed(() => {
  const acct = account.data.value
  /** 服务端直接给可读档位名（A15 `planName`）⇒ 用之（接口模式下的权威来源）。 */
  if (acct?.planName) return acct.planName
  const planId = acct?.planId || user.value?.planId
  const list = table.data.value?.rows || []
  const hit = list.find((p) => p.planId === planId)
  if (hit) return hit.name
  if (acct && acct.accountExists === false) return '未开通'
  return planId ? '未开通' : '—'
})

const stateNote = computed(() => `数据状态：${isMock.value ? '演示数据' : '线上数据'}`)
/**
 * 声明条（按数据源分叉，与事实一致）：
 *  · mock 模式：沿用 A17 原文（此处用量确为示意值）；A17 未取到时回落固定文案。
 *  · api 模式：用量已是服务端真值 ⇒ **不得**声称「用量…示意值」，只保留价格「非报价」口径；
 *    A17 未取到（加载中 / 失败）⇒ **整条省略**（返回空串，模板按 `v-if` 不渲染）——
 *    绝不拿默认串冒充正常文案（否则会把 A17 失败伪装成正常态）。
 */
const MOCK_DISCLAIMER = '本页金额、单价、用量数字均为界面示意值，非报价'
const disclaimer = computed(() => {
  if (isMock.value) {
    return table.data.value?.disclaimer || MOCK_DISCLAIMER
  }
  const tableData = table.data.value
  if (!tableData) return ''
  return tableData.isDemoPrice === true ? '本页金额与单价为演示价，非报价' : '本页金额与单价非报价'
})

const navItems = [
  { to: '/console/overview', label: '概览' },
  { to: '/console/keys', label: '密钥管理' },
  { to: '/console/usage', label: '用量明细' },
  { to: '/console/billing', label: '充值账单' },
]

/** M2 / M3 入口：指向营销站已存在的路由占位（避免在控制台侧重复实现第二份文档/FAQ） */
const externalItems = [
  { href: '/docs', label: 'API 文档' },
  { href: '/help', label: '帮助中心' },
]

async function handleSignOut() {
  await signOut()
  router.push({ name: 'console-login' })
}
</script>

<style scoped>
/* 顶栏套餐档位（§1.3 04-1 要素；D6）：文字色沿用 tokens，不新增颜色字面量 */
.top-plan { display: inline-flex; align-items: baseline; gap: var(--sp-2); color: var(--ink-2); }
.top-plan i { font-style: normal; font-size: var(--fs-12); color: var(--faint); letter-spacing: var(--ls-2); }
</style>
