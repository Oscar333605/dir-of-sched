// 运行监控模块（引擎侧）。
// 职责：
//   1. 指标采集：接口请求、发送任务、错误、自愈动作等运行数据的内存聚合与落盘
//   2. 日志记录：结构化日志（JSON Lines），按天滚动写入 logs/ 目录
//   3. 自动修复：对可判定、可安全重试的异常执行自愈动作（见 SELF_HEAL）
//   4. 告警：异常达到阈值时记录告警事件（可经 webhook 推送，见 config.alerts）
//
// 设计边界（重要）：
//   - 本模块只做「可观测 + 可安全自愈」。绝不做破坏性动作（删数据、改用户数据、发邮件轰炸）。
//   - 自愈仅限幂等、无副作用、可回滚的动作（如重试发送、刷新 token 缓存、重启连接）。
//   - 无法自动处理的异常 → 降级为「记录告警 + 保持 pending 待下轮重试 + 通知」。
const fs = require('fs')
const path = require('path')

const LOG_DIR = path.join(__dirname, '..', 'logs')
const DEFAULT_WINDOW_MS = 10 * 60 * 1000 // 指标聚合窗口默认 10 分钟
const MAX_EVENTS = 500 // 内存保留的最近事件条数上限

// ---- 内存态（进程级，重启后清零；持久化靠日志文件）----
const state = {
  startedAt: Date.now(),
  counters: {
    sweepTotal: 0,     // 处理的提醒总数
    sweepOk: 0,        // 至少一个渠道成功
    sweepAllFail: 0,   // 所有渠道均失败
    channelEmailOk: 0, channelEmailFail: 0,
    channelWechatOk: 0, channelWechatFail: 0,
    channelSmsOk: 0, channelSmsFail: 0,
    httpRequests: 0, httpErrors: 0,
    selfHealAttempts: 0, selfHealSuccess: 0
  },
  // 滚动事件环形缓冲（最近 MAX_EVENTS 条）
  events: [],
  // 错误时间序列（用于计算错误率/触发告警）
  errorTimes: []
}

function pushEvent(ev) {
  state.events.push(ev)
  if (state.events.length > MAX_EVENTS) state.events.shift()
}

// ---- 日志落盘（JSON Lines，按天滚动）----
function ensureLogDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }) } catch (e) { /* 忽略 */ }
}

function logFileName() {
  const d = new Date()
  const p = function (n) { return n < 10 ? '0' + n : '' + n }
  return 'monitor-' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '.log'
}

function writeLog(level, ev) {
  ensureLogDir()
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level: level,
    ...ev
  })
  try {
    fs.appendFileSync(path.join(LOG_DIR, logFileName()), line + '\n')
  } catch (e) { /* 落盘失败不阻断主流程 */ }
}

// 对外日志接口
function log(level, ev) {
  if (level === 'error') {
    state.errorTimes.push(Date.now())
    if (state.errorTimes.length > MAX_EVENTS) state.errorTimes.shift()
  }
  pushEvent({ ts: Date.now(), level: level, ...ev })
  writeLog(level, ev)
}

// ---- 指标聚合 ----
function snapshot() {
  const now = Date.now()
  const windowMs = DEFAULT_WINDOW_MS
  const errorsInWindow = state.errorTimes.filter(function (t) { return t > now - windowMs }).length
  const windowEvents = state.events.filter(function (e) { return e.ts > now - windowMs })
  return {
    ts: now,
    uptimeSec: Math.round((now - state.startedAt) / 1000),
    counters: Object.assign({}, state.counters),
    errorCountWindow: errorsInWindow,
    eventCountWindow: windowEvents.length,
    // 成功/失败比率（供看板与告警判断）
    sweepSuccessRate: state.counters.sweepTotal > 0
      ? +(state.counters.sweepOk / state.counters.sweepTotal).toFixed(4)
      : null,
    recentEvents: state.events.slice(-20)
  }
}

// ---- 自愈动作（白名单，仅幂等/安全操作）----
const SELF_HEAL = {
  // 刷新微信 access_token 缓存（失败后强制失效，下次自动重新获取）
  refresh_wechat_token: {
    label: '刷新微信 access_token 缓存',
    safe: true,
    run: function () {
      try {
        const wechat = require('../channels/wechat')
        if (wechat && typeof wechat.invalidateToken === 'function') wechat.invalidateToken()
        return true
      } catch (e) {
        return false
      }
    }
  },
  // 重建邮件 transporter（连接异常时释放旧连接，下次重建）
  reset_email_transporter: {
    label: '重建邮件 SMTP 连接',
    safe: true,
    run: function () {
      try {
        const email = require('../channels/email')
        if (email && typeof email.resetTransporter === 'function') email.resetTransporter()
        return true
      } catch (e) {
        return false
      }
    }
  }
}

// 根据错误类型决定可执行的自愈动作（映射规则）
function healActionsFor(errType) {
  const map = {
    'wechat.access_token_fail': ['refresh_wechat_token'],
    'email.smtp_conn_fail': ['reset_email_transporter']
  }
  return map[errType] || []
}

// 尝试自愈：返回 { attempted, succeeded, actions }
async function selfHeal(errType) {
  const actions = healActionsFor(errType)
  const result = { attempted: actions.length > 0, succeeded: 0, actions: [] }
  for (const name of actions) {
    const def = SELF_HEAL[name]
    if (!def) continue
    state.counters.selfHealAttempts++
    let ok = false
    try { ok = def.run() } catch (e) { ok = false }
    if (ok) {
      state.counters.selfHealSuccess++
      result.succeeded++
    }
    result.actions.push({ name: name, label: def.label, ok: ok })
    log(ok ? 'info' : 'warn', { kind: 'self_heal', action: name, ok: ok })
  }
  return result
}

// ---- 告警 ----
const ALERT_THRESHOLDS = {
  sweepAllFailRate: 0.8, // 窗口内全部失败占比 ≥ 80% 触发
  sweepMinSample: 5,     // 窗口内至少 5 条才评估失败率（避免小样本误报）
  errorBurst: 10         // 窗口内错误数 ≥ 10 触发错误突发告警
}

// 判断当前是否应告警；返回告警事件数组（可能为空）
function evaluateAlerts(snap) {
  const alerts = []
  if (snap.counters.sweepTotal >= ALERT_THRESHOLDS.sweepMinSample) {
    const failRate = snap.counters.sweepTotal > 0
      ? snap.counters.sweepAllFail / snap.counters.sweepTotal : 0
    if (failRate >= ALERT_THRESHOLDS.sweepAllFailRate) {
      alerts.push({
        type: 'high_failure_rate',
        level: 'warning',
        message: '提醒发送失败率过高：' + Math.round(failRate * 100) + '%（' +
          snap.counters.sweepAllFail + '/' + snap.counters.sweepTotal + '）'
      })
    }
  }
  if (snap.errorCountWindow >= ALERT_THRESHOLDS.errorBurst) {
    alerts.push({
      type: 'error_burst',
      level: 'warning',
      message: '错误突发：近 10 分钟 ' + snap.errorCountWindow + ' 次错误'
    })
  }
  return alerts
}

// 触发告警：记录日志 + 可选 webhook 推送（若 config.alerts.webhookUrl 已配置）
async function raiseAlert(alert) {
  const ev = { kind: 'alert', type: alert.type, level: alert.level, message: alert.message }
  log('warn', ev)
  const cfg = require('../config')
  if (cfg.alerts && cfg.alerts.webhookUrl) {
    try {
      await fetch(cfg.alerts.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...ev, ts: new Date().toISOString() })
      })
    } catch (e) {
      // webhook 推送失败仅记录，不抛异常
      log('warn', { kind: 'alert', type: 'webhook_fail', message: e && e.message })
    }
  }
}

// 供外部在每次 sweep 后调用：聚合 + 评估告警
async function afterSweep(results) {
  for (const r of results || []) {
    state.counters.sweepTotal++
    const channels = r.channels || []
    const anyOk = channels.some(function (c) { return c.status === 'ok' || c.status === 'sent' })
    if (anyOk) state.counters.sweepOk++
    else state.counters.sweepAllFail++
    channels.forEach(function (c) {
      if (c.channel === 'email') { if (c.status === 'ok') state.counters.channelEmailOk++; else if (c.status === 'fail') state.counters.channelEmailFail++ }
      else if (c.channel === 'wechat') { if (c.status === 'ok') state.counters.channelWechatOk++; else if (c.status === 'fail') state.counters.channelWechatFail++ }
      else if (c.channel === 'sms') { if (c.status === 'ok') state.counters.channelSmsOk++; else if (c.status === 'fail') state.counters.channelSmsFail++ }
    })
  }
  const snap = snapshot()
  const alerts = evaluateAlerts(snap)
  for (const a of alerts) await raiseAlert(a)
  return { snapshot: snap, alerts: alerts }
}

module.exports = {
  log,
  snapshot,
  selfHeal,
  afterSweep,
  evaluateAlerts,
  raiseAlert,
  SELF_HEAL,
  ALERT_THRESHOLDS,
  _state: state
}
