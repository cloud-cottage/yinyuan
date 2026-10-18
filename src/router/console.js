/**
 * 控制台入口路由表 —— spec §2.2 #3–#9（M1）+ #10/#13 的控制台外链。
 * 路由规则见 §2.3：未登录守卫、已登录重定向、查询参数约定。
 */
import { createRouter, createWebHistory } from 'vue-router'
import { APP_CONFIG } from '@/config/app-config.js'
import { clearSessionState, ensureSession } from '@/composables/useAuth.js'
import { onSessionExpired } from '@/data'

const NotFoundPage = () => import('@/pages/NotFoundPage.vue')

export const consoleRoutes = [
  {
    path: '/console/login',
    name: 'console-login',
    component: () => import('@/pages/console/LoginPage.vue'),
    meta: { entry: 'console', milestone: 'M1', title: '登录', specRef: 'P-M1-03', guestOnly: true },
  },
  {
    path: '/console/register',
    name: 'console-register',
    component: () => import('@/pages/console/RegisterPage.vue'),
    meta: { entry: 'console', milestone: 'M1', title: '注册', specRef: 'P-M1-02', guestOnly: true },
  },
  {
    // #5 `/console` → 重定向至 `/console/overview`（§2.2）
    path: '/console',
    redirect: { name: 'console-overview' },
  },
  {
    path: '/console/overview',
    name: 'console-overview',
    component: () => import('@/pages/console/OverviewPage.vue'),
    meta: { entry: 'console', milestone: 'M1', title: '控制台概览', specRef: 'P-M1-04', requiresAuth: true },
  },
  {
    path: '/console/keys',
    name: 'console-keys',
    component: () => import('@/pages/console/KeysPage.vue'),
    meta: { entry: 'console', milestone: 'M1', title: '密钥管理', specRef: 'P-M1-05', requiresAuth: true },
  },
  {
    // §2.3-4 查询参数约定：/console/usage?range=&keys=&endpoints=&env=
    path: '/console/usage',
    name: 'console-usage',
    component: () => import('@/pages/console/UsagePage.vue'),
    meta: { entry: 'console', milestone: 'M1', title: '用量明细', specRef: 'P-M1-06', requiresAuth: true },
  },
  {
    // §2.3-4 查询参数约定：/console/billing?orderId=xxx
    path: '/console/billing',
    name: 'console-billing',
    component: () => import('@/pages/console/BillingPage.vue'),
    meta: { entry: 'console', milestone: 'M1', title: '充值账单', specRef: 'P-M1-07', requiresAuth: true },
  },
  {
    path: '/console/:pathMatch(.*)*',
    name: 'console-not-found',
    component: NotFoundPage,
    meta: { entry: 'console', title: '页面不存在' },
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes: consoleRoutes,
  scrollBehavior() {
    return { top: 0 }
  },
})

/**
 * 会话失效（适配层判定 401 或本地 `expires_at` 已过）⇒
 *   ① 清内存态（否则守卫会用旧的 `bootPromise` 继续放行，形成「跳登录 → 又被弹回概览」的环）；
 *   ② 跳 `/console/login` 并带上 `redirect`（登录 / 注册两页除外 —— 它们本就无需会话）。
 */
onSessionExpired(() => {
  clearSessionState()
  const current = router.currentRoute.value
  if (current && current.meta && current.meta.guestOnly) return
  const redirect = current && typeof current.fullPath === 'string' && current.fullPath.startsWith('/console')
    ? current.fullPath
    : ''
  const target = redirect ? { name: 'console-login', query: { redirect } } : { name: 'console-login' }
  Promise.resolve(router.replace(target)).catch(() => {})
})

router.beforeEach(async (to) => {
  // §2.3-1 未登录访问 /console/*（除登录、注册）→ 重定向 /console/login 并带 redirect
  // §2.3-2 已登录访问登录 / 注册 → 重定向 /console/overview
  const session = await ensureSession()
  if (to.meta?.requiresAuth && !session) {
    return { name: 'console-login', query: { redirect: to.fullPath } }
  }
  if (to.meta?.guestOnly && session) {
    return { name: 'console-overview' }
  }
  return true
})

router.afterEach((to) => {
  document.title = to.meta?.title ? `${to.meta.title}｜${APP_CONFIG.site.name}控制台` : `${APP_CONFIG.site.name}控制台`
})

export default router
