<template>
  <div class="container">
    <div class="auth-wrap">
      <aside class="auth-aside">
        <p class="eyebrow">控制台</p>
        <h2>机构登录</h2>
        <ul v-if="isMock">
          <li><b>演示环境</b>：登录不校验真实凭证，会话只存于本机浏览器</li>
          <li>账号支持<b>邮箱或手机号</b>；密码至少 8 位且需含字母与数字</li>
          <li>尚未开通的机构可走「申请演示环境」通道（长期保留）</li>
        </ul>
        <ul v-else>
          <li><b>账号即手机号或邮箱</b>，口令由服务端校验（不回显、不明文存储）</li>
          <li>登录状态保存在<b>本浏览器会话</b>内（关窗即失效），不写入本地持久存储</li>
          <li>登录失败一律同一提示，不区分「账号不存在」与「口令不正确」</li>
          <li>尚未开通的机构可走「申请演示环境」通道（长期保留）</li>
        </ul>
      </aside>

      <section class="auth-main">
        <!-- 03-4 声明（按数据源切换，文案不得与实现相反） -->
        <NoticeBar variant="warn" data-role="login-disclaimer">
          <template v-if="isMock">演示环境：登录不校验真实凭证</template>
          <template v-else>真实账号：登录由服务端校验，会话有效期 7 天（保存在本浏览器会话内）</template>
        </NoticeBar>

        <!-- 03-1 登录表单 -->
        <form novalidate @submit.prevent="submit">
          <div class="field">
            <label for="login-account">账号（邮箱 / 手机号）</label>
            <input
              id="login-account" v-model.trim="form.account" type="text" autocomplete="username"
              placeholder="demo@yinyuan.example 或 11 位手机号"
              :aria-invalid="showError('account') || undefined"
              :aria-describedby="showError('account') ? 'login-account-error' : undefined"
              @blur="touch('account')"
            />
            <p v-if="showError('account')" id="login-account-error" class="field-error" data-error-for="account">{{ errors.account }}</p>
          </div>

          <div class="field">
            <label for="login-password">密码</label>
            <input
              id="login-password" v-model="form.password" type="password" autocomplete="current-password"
              placeholder="至少 8 位，含字母与数字"
              :aria-invalid="showError('password') || undefined"
              :aria-describedby="showError('password') ? 'login-password-error' : undefined"
              @blur="touch('password')"
            />
            <p v-if="showError('password')" id="login-password-error" class="field-error" data-error-for="password">{{ errors.password }}</p>
          </div>

          <div class="field">
            <label for="login-captcha">图形验证码</label>
            <div class="field-row">
              <input
                id="login-captcha" v-model.trim="form.captcha" type="text" maxlength="4" placeholder="填写右侧图形字符"
                :aria-invalid="showError('captcha') || undefined"
                :aria-describedby="showError('captcha') ? 'login-captcha-error' : undefined"
                @blur="touch('captcha')"
              />
              <!-- 图形占位（R9：纯 CSS 占位、零外链、零真实请求） -->
              <div class="cap-box" aria-hidden="true">DEMO<span>图形占位</span></div>
            </div>
            <p v-if="showError('captcha')" id="login-captcha-error" class="field-error" data-error-for="captcha">{{ errors.captcha }}</p>
            <p v-else-if="isMock" class="hint">图形验证码为占位（演示态），任意填写即可，仅作非空校验</p>
            <p v-else class="hint">图形验证码为本地占位（服务端登录不校验验证码），任意填写即可，仅作非空校验</p>
          </div>

          <label class="checkline" for="login-remember">
            <input id="login-remember" v-model="form.remember" type="checkbox" />
            <span v-if="isMock">记住我（演示态：会话统一保存于本机浏览器会话，勾选与否不改变存储位置）</span>
            <span v-else>记住我（会话统一保存于本浏览器会话，勾选与否不改变存储位置）</span>
          </label>

          <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;">
            <button class="btn" type="submit" :disabled="submitting" data-action="login-submit">
              {{ submitting ? '登录中…' : '登录' }}
            </button>
            <!-- 03-3 演示账号一键登录：文案 / 凭证 / 开关全部来自站点配置，登录调用走数据源适配层（不区分实现） -->
            <button
              v-if="demoSignInAvailable" class="btn ghost" type="button" :disabled="submitting" data-action="fill-demo"
              @click="demoSignIn"
            >{{ demo.buttonLabel }}</button>
          </div>

          <p v-if="demoSignInAvailable" class="hint" data-block="demo-account">
            演示账号：<code class="mono">{{ demo.account }}</code><template v-if="isMock">（演示态提供，仅用于界面演示）</template><template v-else>（服务端预置账号）</template>；
            <template v-if="isMock">点击「{{ demo.buttonLabel }}」一次点击即完成登录并进入控制台；登录后如需手动试填，修改账号 / 密码再点「登录」即可</template>
            <template v-else>点击「{{ demo.buttonLabel }}」由服务端为该预置演示账号直接签发会话（无需填写上方表单，也不外发口令），一次点击即进入控制台</template>
          </p>
          <p v-if="submitting" class="hint" data-hint="submitting">正在校验登录信息，请稍候…</p>

          <!-- 提交失败/校验失败一律内联展示，不弹全局错误 -->
          <p v-if="submitError" class="field-error" role="alert" data-error="submit">{{ submitError }}</p>
        </form>

        <!-- 03-2 辅助入口 -->
        <div class="modal-acts">
          <router-link class="btn ghost sm" to="/console/register">还没有账号？注册</router-link>
          <EntryLink class="btn ghost sm" to="/demo">申请演示环境</EntryLink>
          <button class="btn ghost sm" type="button" data-action="forgot" @click="notifyForgot">忘记密码</button>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
/**
 * P-M1-03 登录页。
 *
 * 要素 03-1～03-4 与交互 1～4 逐项落地：
 *  - 表单（03-1）：账号（邮箱 / 手机号合并）+ 密码 + 图形验证码（占位）+ 记住我；
 *  - 辅助入口（03-2）：忘记密码（占位提示）、还没有账号？注册、申请演示环境；
 *  - 演示账号提示（03-3）：一次点击即登录（填凭证 → 满足占位验证码 → 提交 → 跳转），账号来自配置（不硬编码）；
 *  - 声明（03-4）：「演示环境：登录不校验真实凭证」；
 *  - 校验失败 → 字段内联错误，不弹全局错误；成功后写入会话并支持 `redirect` 回跳；
 *  - 已登录访问本页由路由守卫重定向至概览。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import EntryLink from '@/components/EntryLink.vue'
import NoticeBar from '@/components/NoticeBar.vue'
import { useAppConfig } from '@/composables/useAppConfig.js'
import { useAuth } from '@/composables/useAuth.js'
import { toastNotConnected } from '@/composables/useToast.js'
import { RESOLVED_DATA_SOURCE, isAuthFailure, isRateLimited, isServiceUnavailable } from '@/data'

const router = useRouter()
const route = useRoute()
const { demo, loadAppConfig } = useAppConfig()
const { signIn, signInDemo } = useAuth()

/** 当前数据源：文案与错误分派按它切换（`mock` 展示演示口径，`api` 展示真实账号口径）。 */
const isMock = RESOLVED_DATA_SOURCE === 'mock'

/**
 * 演示账号入口是否显现（只由配置开关 `demo.signInEnabled` 决定，mock / api 两种数据源都显现）：
 *   · 文案来自配置（口令除外 —— api 模式的 `demo` 段不含口令，也不需要口令）；
 *   · 点击行为按数据源分派：mock ⇒ 填表走既有 `submit()`；api ⇒ `signInDemo()`（服务端签发，无请求体）。
 */
const demoSignInAvailable = computed(() => !!demo.value?.signInEnabled)

/** 401 统一文案（服务端反探测：账号不存在 / 口令错 / 停用**同形同文案**，此处不再细分）。 */
const AUTH_FAILED_TEXT = '手机号 / 邮箱或口令不正确'
/** 429 统一文案（限流窗口：同 IP 10 分钟 / 同账号 10 分钟）。 */
const RATE_LIMITED_TEXT = '尝试过于频繁，请稍后再试'

const form = reactive({ account: '', password: '', captcha: '', remember: true })
const submitting = ref(false)
const submitError = ref('')
const attempted = ref(false)
const touched = reactive({})
/** 适配层返回的字段级错误（如口令不正确）——仍以字段内联方式展示。 */
const serverError = reactive({})

const errors = computed(() => {
  const e = {}
  if (!form.account.trim()) e.account = '请输入账号（邮箱或手机号）'
  if (String(form.password).length < 8) e.password = '密码至少 8 位'
  if (!form.captcha.trim()) e.captcha = '请输入图形验证码'
  for (const [k, v] of Object.entries(serverError)) if (v) e[k] = v
  return e
})

/** 字段错误展示时机：失焦后或提交尝试后（首次提交前不预先报错）。 */
function showError(field) {
  return !!errors.value[field] && (attempted.value || !!touched[field])
}
function touch(field) {
  touched[field] = true
}

/** 账号或密码改动即清除服务端内联错误。 */
watch([() => form.account, () => form.password], () => { delete serverError.account })

onMounted(async () => {
  await loadAppConfig()
})

/**
 * 03-3：一键演示登录（按数据源分派，两条通路都经 `@/data` 适配层，不绕过会话落盘）：
 *
 *   · **mock**：先填凭证（含占位图形验证码），随即走既有 `submit()` —— 与「手动提交」共用
 *     同一条校验 / 登录 / 回跳链路（不做任何绕过，验证码仍是非空校验）。
 *   · **api**：不填表单、不传口令 —— `signInDemo()` 打 `POST /api/v1/auth/demo-login`（无请求体），
 *     服务端为预置演示账号签发会话。失败（401 / 429 / 503 / 网络）一律**可见**，绝不静默成功。
 */
async function demoSignIn() {
  const cred = demo.value
  if (!cred) return
  if (isMock) {
    form.account = cred.account
    form.password = cred.password
    form.captcha = cred.captcha
    await submit()
    return
  }

  submitError.value = ''
  delete serverError.account
  submitting.value = true
  try {
    await signInDemo()
    await redirectAfterLogin()
  } catch (e) {
    handleDemoFailure(e)
  } finally {
    submitting.value = false
  }
}

/** 登录成功后的回跳：仅接受站内 `/console/**` 目标，其余一律回概览。 */
function redirectAfterLogin() {
  const raw = typeof route.query.redirect === 'string' ? route.query.redirect : ''
  const target = raw.startsWith('/console') ? raw : null
  return router.replace(target || { name: 'console-overview' })
}

/**
 * 手动登录失败分派（B3）：
 *   · 401 → **统一文案**内联到账号字段（服务端反探测，前端也不细分账号/口令/停用）；
 *   · 429 → 「稍后再试」（限流，非凭据问题 ⇒ 不指责账号）；
 *   · 503 / 网络 → 服务不可用类提示（不是用户错，不要暗示口令有误）；
 *   · 其余 → 服务端文案。
 */
function handleLoginFailure(e) {
  if (isAuthFailure(e)) {
    serverError.account = AUTH_FAILED_TEXT
  } else if (isRateLimited(e)) {
    submitError.value = RATE_LIMITED_TEXT
  } else if (isServiceUnavailable(e) || e?.reason === 'NETWORK_ERROR') {
    submitError.value = e?.message || '登录服务暂时不可用，请稍后重试'
  } else {
    submitError.value = e?.message || '登录失败，请稍后重试'
  }
}

/**
 * 演示一键登录失败分派（api 模式）：表单里没填东西 ⇒ 错误一律走**页面级内联提示**，
 * 文案点明是「演示账号入口」出的问题（不要把 401 说成用户口令错 —— 用户根本没输口令）。
 */
function handleDemoFailure(e) {
  if (isRateLimited(e)) {
    submitError.value = RATE_LIMITED_TEXT
  } else if (isAuthFailure(e)) {
    submitError.value = '演示账号登录失败：服务端未预置该演示账号（401），请改用账号 / 口令登录'
  } else if (isServiceUnavailable(e) || e?.reason === 'NETWORK_ERROR') {
    submitError.value = e?.message || '演示账号登录暂时不可用，请稍后重试'
  } else {
    submitError.value = e?.message || '演示账号登录失败，请稍后重试'
  }
}

async function submit() {
  submitError.value = ''
  delete serverError.account
  attempted.value = true
  // 字段级校验不通过 → 内联错误已展示，直接返回，不弹全局错误
  if (Object.keys(errors.value).length) return

  submitting.value = true
  try {
    await signIn(form.account, form.password)
    await redirectAfterLogin()
  } catch (e) {
    handleLoginFailure(e)
  } finally {
    submitting.value = false
  }
}

function notifyForgot() {
  toastNotConnected('演示环境：找回密码通路未接入')
}
</script>
