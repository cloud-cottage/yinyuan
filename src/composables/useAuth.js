/**
 * 会话状态（模块级单例，两个入口各自独立；会话经适配层 sessionStorage 持久化，可跨入口共享）。
 * 页面不得直接 import mock：只经 '@/data' 的 A2/A3/A4 方法。
 */
import { computed, ref } from 'vue'
import { getSession, login as adapterLogin, loginDemo as adapterLoginDemo, logout as adapterLogout, register as adapterRegister } from '@/data'

const EMPTY_FLAGS = Object.freeze({})

const user = ref(null)
const loading = ref(false)
const initialized = ref(false)
let bootPromise = null

/** 首次导航前解析一次会话（含 §8.3-4 的人工延迟），后续复用同一 Promise。 */
export function ensureSession(force = false) {
  if (force || !bootPromise) {
    loading.value = true
    bootPromise = getSession()
      .then((u) => {
        user.value = u
        return u
      })
      .catch(() => {
        user.value = null
        return null
      })
      .finally(() => {
        initialized.value = true
        loading.value = false
      })
  }
  return bootPromise
}

/**
 * 会话失效时清内存态（B3）。
 *
 * 由路由守卫在适配层派发 `session-expired` 时调用：把 `bootPromise` 归零为「已解析的 null」，
 * 否则守卫下次仍拿旧 Promise 里的 user 放行，`guestOnly` 规则会把用户从登录页再弹回概览。
 */
export function clearSessionState() {
  user.value = null
  initialized.value = true
  loading.value = false
  bootPromise = Promise.resolve(null)
}

export function useAuth() {
  return {
    user,
    loading,
    initialized,
    isAuthenticated: computed(() => !!user.value),
    planId: computed(() => user.value?.planId || null),
    featureFlags: computed(() => user.value?.featureFlags || EMPTY_FLAGS),
    ensureSession,
    async signIn(account, password) {
      const result = await adapterLogin(account, password)
      user.value = result.user
      bootPromise = Promise.resolve(result.user)
      initialized.value = true
      return result
    },
    /** 演示账号一键登录：api 模式由服务端预置账号签发（不传口令）；mock 模式等价于用配置凭证登录。 */
    async signInDemo() {
      const result = await adapterLoginDemo()
      user.value = result.user
      bootPromise = Promise.resolve(result.user)
      initialized.value = true
      return result
    },
    async signUp(input) {
      const result = await adapterRegister(input)
      user.value = result.user
      bootPromise = Promise.resolve(result.user)
      initialized.value = true
      return result
    },
    async signOut() {
      await adapterLogout()
      user.value = null
      bootPromise = Promise.resolve(null)
    },
  }
}
