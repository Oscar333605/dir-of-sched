// 前端运行监控采集模块。
// 职责：采集小程序端运行状态（接口耗时/错误、页面异常、启动信息），本地持久化，
//       供「监控看板」页读取展示。数据不上传外部，仅存本机 Storage。
//
// 采集范围（与后端监控互补，覆盖「客户端视角」）：
//   1. 接口请求：耗时、状态码、失败原因（复用 workbuddy-cloud-diagnostics 的失败拦截点）
//   2. 页面异常：JS 运行时错误、未处理的 Promise 拒绝
//   3. 性能：接口响应耗时分布、页面渲染耗时（可选）
//   4. 环境信息：AppID、SDK 版本、首次启动时间
//
// 设计边界：本模块只做「采集 + 记录」，不做自动修复（客户端无法安全自愈），
// 异常统一降级为「记录 + 用户可见提示」。后端才具备自愈能力。

const STORAGE_KEY = 'dos_monitor_state'
const MAX_EVENTS = 200 // 本地最多保留的事件条数
const MAX_ERRORS = 100

function pad(n) { return n < 10 ? '0' + n : '' + n }

function now() {
  return Date.now()
}

// 读取本地持久化状态
function loadState() {
  try {
    const raw = wx.getStorageSync(STORAGE_KEY)
    if (raw && raw.startedAt) return raw
  } catch (e) { /* 忽略 */ }
  return {
    startedAt: now(),
    counters: {
      apiTotal: 0, apiOk: 0, apiFail: 0, apiSlow: 0,
      jsErrors: 0, rejectionErrors: 0
    },
    events: [],
    errors: []
  }
}

let state = loadState()

function persist() {
  try {
    wx.setStorageSync(STORAGE_KEY, state)
  } catch (e) { /* 存储失败不影响主流程 */ }
}

function pushEvent(ev) {
  state.events.push(ev)
  if (state.events.length > MAX_EVENTS) state.events.shift()
}

function pushError(ev) {
  state.errors.push(ev)
  if (state.errors.length > MAX_ERRORS) state.errors.shift()
  persist()
}

// 记录一次接口请求结果
function recordApi(opts) {
  state.counters.apiTotal++
  const durationMs = opts.durationMs || 0
  const isError = opts.statusCode >= 400 || opts.statusCode === 0
  if (isError) state.counters.apiFail++
  else state.counters.apiOk++
  if (durationMs > 3000) state.counters.apiSlow++ // 超过 3 秒视为慢请求

  pushEvent({
    ts: now(),
    kind: 'api',
    method: opts.method || 'GET',
    url: opts.url || '',
    statusCode: opts.statusCode || 0,
    durationMs: durationMs
  })

  if (isError) {
    pushError({
      ts: now(),
      kind: 'api_error',
      method: opts.method || 'GET',
      url: opts.url || '',
      statusCode: opts.statusCode || 0,
      message: opts.message || ''
    })
  }
}

// 记录 JS 运行时错误
function recordJsError(message, stack) {
  state.counters.jsErrors++
  pushError({
    ts: now(),
    kind: 'js_error',
    message: message || '',
    stack: (stack || '').slice(0, 500)
  })
}

// 记录未处理 Promise 拒绝
function recordRejection(message) {
  state.counters.rejectionErrors++
  pushError({
    ts: now(),
    kind: 'rejection',
    message: message || ''
  })
}

// 采集环境信息
function recordEnv() {
  try {
    const info = wx.getAccountInfoSync && wx.getAccountInfoSync()
    state.env = {
      appid: (info && info.miniProgram && info.miniProgram.appId) || '',
      version: (info && info.miniProgram && info.miniProgram.version) || '',
      sdkVersion: (info && info.SDKVersion) || wx.getSystemInfoSync().SDKVersion
    }
    persist()
  } catch (e) { /* 忽略 */ }
}

// 安装全局异常钩子（在 app.js onLaunch 里调用一次）
function install() {
  recordEnv()

  // 覆盖 wx.request 以采集接口指标（保留原行为）
  if (wx.request && !wx.__dosMonitored) {
    const original = wx.request
    wx.request = function (options) {
      const startedAt = now()
      const wrapped = Object.assign({}, options)
      wrapped.success = function (res) {
        try { recordApi({ method: (options.method || 'GET').toUpperCase(), url: options.url, statusCode: res.statusCode, durationMs: now() - startedAt }) } catch (e) {}
        if (options.success) options.success.call(this, res)
      }
      wrapped.fail = function (res) {
        try { recordApi({ method: (options.method || 'GET').toUpperCase(), url: options.url, statusCode: 0, durationMs: now() - startedAt, message: res.errMsg }) } catch (e) {}
        if (options.fail) options.fail.call(this, res)
      }
      return original.call(this, wrapped)
    }
    wx.__dosMonitored = true
  }
}

// 获取当前监控快照（供看板页调用）
function snapshot() {
  const apiTotal = state.counters.apiTotal
  const failRate = apiTotal > 0 ? +(state.counters.apiFail / apiTotal).toFixed(4) : null
  return {
    startedAt: state.startedAt,
    uptimeMs: now() - state.startedAt,
    env: state.env || {},
    counters: Object.assign({}, state.counters),
    apiFailRate: failRate,
    recentErrors: state.errors.slice(-30).reverse(),
    recentEvents: state.events.slice(-30).reverse()
  }
}

// 清空监控数据（看板提供手动重置）
function reset() {
  state = {
    startedAt: now(),
    counters: {
      apiTotal: 0, apiOk: 0, apiFail: 0, apiSlow: 0,
      jsErrors: 0, rejectionErrors: 0
    },
    events: [],
    errors: []
  }
  persist()
}

module.exports = { install, snapshot, recordApi, recordJsError, recordRejection, reset }
