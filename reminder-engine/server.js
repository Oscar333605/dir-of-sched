// 提醒引擎 · 常驻 HTTP 服务。
// 功能：
//   1. POST /sweep           接收待发提醒 JSON 数组并发送（复用 dispatch 逻辑）
//   2. POST /api/wx/openid   收集微信 openid（jscode2session）
//   3. GET  /health          健康检查
//   4. 内置：进程守护（异常捕获 + 自动恢复）、并发控制、优雅关闭、接口 Token 鉴权
//
// 说明：本服务不直接查询云数据库（云数据库无对外直连能力，由 WorkBuddy 调度器负责查库并调用 /sweep）。
// 它负责「稳定、可自愈」地执行发送动作，可独立部署为常驻服务。
const http = require('http')
const { dispatchOne } = require('./lib/dispatch')
const wechat = require('./channels/wechat')
const monitor = require('./lib/monitor')
const config = require('./config')

const PORT = process.env.PORT || 8787
const HOST = process.env.HOST || '0.0.0.0'
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '5', 10) // 同时发送的提醒条数上限

// 接口鉴权 Token：通过环境变量 AUTH_TOKEN 设置。为空表示不启用鉴权（内网自用）。
const AUTH_TOKEN = process.env.AUTH_TOKEN || ''

// ---- 并发控制：一个简单的信号量，限制同时进行的发送任务数 ----
function createSemaphore(limit) {
  let active = 0
  const queue = []
  function next() {
    if (queue.length === 0 || active >= limit) return
    const job = queue.shift()
    active++
    job().finally(function () {
      active--
      next()
    })
  }
  return {
    run: function (fn) {
      return new Promise(function (resolve, reject) {
        queue.push(function () {
          return Promise.resolve().then(fn).then(resolve, reject)
        })
        next()
      })
    }
  }
}
const semaphore = createSemaphore(MAX_CONCURRENT)

async function handleSweep(payload) {
  const reminders = Array.isArray(payload) ? payload : (payload && payload.reminders) || []
  const jobs = reminders.map(function (r) { return semaphore.run(function () { return dispatchOne(r) }) })
  const results = await Promise.all(jobs)
  // 发送完成后采集指标 + 评估告警
  await monitor.afterSweep(results)
  return results
}

// ---- 读取 JSON 请求体（带大小上限，防滥用）----
function readBody(req) {
  return new Promise(function (resolve, reject) {
    let data = ''
    let settled = false
    req.on('data', function (c) {
      data += c
      if (data.length > 10 * 1024 * 1024) { // 10MB 上限
        if (!settled) { settled = true; reject(new Error('payload too large')) }
        req.destroy()
      }
    })
    req.on('end', function () { if (!settled) { settled = true; resolve(data) } })
    req.on('error', function (e) { if (!settled) { settled = true; reject(e) } })
  })
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(body)
}

// 校验请求是否携带正确的鉴权 Token
function authorized(req) {
  if (!AUTH_TOKEN) return true
  const token = req.headers['x-auth-token'] || req.headers['authorization']
  return token === AUTH_TOKEN || token === 'Bearer ' + AUTH_TOKEN
}

// ---- HTTP 服务器 ----
const server = http.createServer(async function (req, res) {
  const url = (req.url || '').split('?')[0]
  const method = req.method || 'GET'
  monitor.log('info', { kind: 'http', method: method, url: url })

  // 健康检查（无需鉴权，供探活）：附带运行指标快照
  if (method === 'GET' && url === '/health') {
    const snap = monitor.snapshot()
    return sendJson(res, 200, {
      status: 'ok',
      uptime: Math.round(process.uptime()),
      ts: Date.now(),
      metrics: {
        counters: snap.counters,
        errorCountWindow: snap.errorCountWindow,
        sweepSuccessRate: snap.sweepSuccessRate
      }
    })
  }

  // 其余写接口统一鉴权
  if (!authorized(req)) {
    monitor.log('warn', { kind: 'http', method: method, url: url, unauthorized: true })
    return sendJson(res, 401, { error: 'unauthorized' })
  }

  // 运行指标（需鉴权）
  if (method === 'GET' && url === '/metrics') {
    return sendJson(res, 200, monitor.snapshot())
  }

  // 自检（需鉴权）：返回当前健康状态与告警评估结果
  if (method === 'GET' && url === '/selfcheck') {
    const snap = monitor.snapshot()
    const alerts = monitor.evaluateAlerts(snap)
    return sendJson(res, 200, {
      ok: alerts.length === 0,
      alerts: alerts,
      snapshot: snap
    })
  }

  // 发送提醒
  if (method === 'POST' && url === '/sweep') {
    try {
      const body = await readBody(req)
      const payload = JSON.parse(body || '[]')
      const out = await handleSweep(payload)
      return sendJson(res, 200, { ok: true, results: out })
    } catch (e) {
      monitor.log('error', { kind: 'sweep_error', message: e && e.message })
      return sendJson(res, 400, { ok: false, error: e.message })
    }
  }

  // 收集 openid
  if (method === 'POST' && url === '/api/wx/openid') {
    try {
      const body = await readBody(req)
      const payload = JSON.parse(body || '{}')
      const { openid } = await wechat.jscode2session(payload.code)
      return sendJson(res, 200, { openid: openid })
    } catch (e) {
      monitor.log('error', { kind: 'openid_error', message: e && e.message })
      return sendJson(res, 400, { error: e.message })
    }
  }

  sendJson(res, 404, { error: 'not found' })
})

// ---- 进程守护：捕获未处理异常/拒绝，记录日志但不崩溃退出 ----
process.on('uncaughtException', function (err) {
  const msg = err && err.message ? err.message : String(err)
  console.error('[fatal] uncaughtException:', msg)
  monitor.log('error', { kind: 'uncaught_exception', message: msg })
})
process.on('unhandledRejection', function (reason) {
  const msg = reason && reason.message ? reason.message : String(reason)
  console.error('[fatal] unhandledRejection:', msg)
  monitor.log('error', { kind: 'unhandled_rejection', message: msg })
})

// ---- 优雅关闭：收到 SIGTERM/SIGINT 时停止接收新请求、等待处理完成后退出 ----
let shuttingDown = false
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log('[server] received ' + signal + ', shutting down gracefully...')
  server.close(function () {
    console.log('[server] closed. bye.')
    process.exit(0)
  })
  // 兜底：10 秒后强制退出
  setTimeout(function () { process.exit(1) }, 10000).unref()
}
process.on('SIGTERM', function () { shutdown('SIGTERM') })
process.on('SIGINT', function () { shutdown('SIGINT') })

server.listen(PORT, HOST, function () {
  console.log('[reminder-engine] listening on ' + HOST + ':' + PORT)
  console.log('[reminder-engine] max_concurrent=' + MAX_CONCURRENT +
    ', email=' + (config.email && config.email.enabled ? 'on' : 'off') +
    ', wechat=' + (config.wechat && config.wechat.appid ? 'on' : 'off') +
    ', auth=' + (AUTH_TOKEN ? 'on' : 'off'))
})
