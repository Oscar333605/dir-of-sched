const monitor = require('../../utils/monitor')

function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

Page({
  data: {
    snapshot: null,
    view: null,
    // 后端引擎健康状态（可选，若引擎地址未配置则显示未接入）
    engineStatus: 'unknown',   // unknown | ok | down | unconfigured
    engineMetrics: null,
    engineView: null,
    running: false,
    engineBaseUrl: ''
  },

  onShow() {
    this.refresh()
  },

  refresh() {
    this.setData({
      snapshot: monitor.snapshot(),
      view: this.buildClientView(monitor.snapshot())
    })
    this.checkEngine()
  },

  // 预计算展示字段（WXML 不支持方法调用，百分比/时长在此处理）
  buildClientView(snap) {
    if (!snap) return null
    const failRate = snap.apiFailRate === null ? '—' : Math.round(snap.apiFailRate * 100) + '%'
    const errTotal = snap.counters.jsErrors + snap.counters.rejectionErrors
    const errors = (snap.recentErrors || []).map(function (e) {
      return {
        ts: e.ts,
        kind: e.kind,
        message: e.message || e.url || '未知错误',
        url: e.url || '',
        statusCode: e.statusCode,
        timeLabel: fmtTime(e.ts)
      }
    })
    const events = (snap.recentEvents || []).map(function (e) {
      return {
        ts: e.ts,
        method: e.method,
        url: e.url,
        statusCode: e.statusCode,
        durationMs: e.durationMs,
        bad: e.statusCode >= 400 || e.statusCode === 0
      }
    })
    return {
      apiTotal: snap.counters.apiTotal,
      failRate: failRate,
      errTotal: errTotal,
      apiSlow: snap.counters.apiSlow,
      envVersion: (snap.env && snap.env.version) || '',
      sdkVersion: (snap.env && snap.env.sdkVersion) || '',
      errors: errors,
      events: events
    }
  },

  // 探测提醒引擎健康状态（从 utils/config.js 读取引擎地址）
  checkEngine() {
    try {
      const bizConfig = require('../../utils/config')
      const baseUrl = (bizConfig.ENGINE_BASE_URL || '').replace(/\/$/, '')
      if (!baseUrl) {
        this.setData({ engineStatus: 'unconfigured', engineMetrics: null, engineView: null, engineBaseUrl: '' })
        return
      }
      this.setData({ engineBaseUrl: baseUrl })
      wx.request({
        url: baseUrl + '/health',
        method: 'GET',
        timeout: 5000,
        success: (res) => {
          if (res.statusCode === 200 && res.data && res.data.status === 'ok') {
            const m = res.data.metrics || null
            this.setData({ engineStatus: 'ok', engineMetrics: m, engineView: this.buildEngineView(m) })
          } else {
            this.setData({ engineStatus: 'down', engineMetrics: null, engineView: null })
          }
        },
        fail: () => {
          this.setData({ engineStatus: 'down', engineMetrics: null, engineView: null })
        }
      })
    } catch (e) {
      this.setData({ engineStatus: 'unconfigured', engineMetrics: null, engineView: null })
    }
  },

  // 预计算引擎指标展示字段
  buildEngineView(m) {
    if (!m) return null
    const c = m.counters || {}
    const rate = m.sweepSuccessRate === null || m.sweepSuccessRate === undefined
      ? '—' : Math.round(m.sweepSuccessRate * 100) + '%'
    return {
      sweepTotal: c.sweepTotal || 0,
      successRate: rate,
      errorCountWindow: m.errorCountWindow || 0
    }
  },

  // 手动运行一次自检（前端本地 + 引擎探测）
  runSelfCheck() {
    if (this.data.running) return
    this.setData({ running: true })
    this.refresh()
    wx.showToast({ title: '自检完成', icon: 'success' })
    setTimeout(() => { this.setData({ running: false }) }, 600)
  },

  // 清空本地监控数据
  resetMonitor() {
    const that = this
    wx.showModal({
      title: '重置监控数据',
      content: '清空本地采集的运行数据与错误记录？',
      success(res) {
        if (!res.confirm) return
        monitor.reset()
        that.refresh()
        wx.showToast({ title: '已重置', icon: 'success' })
      }
    })
  }
})
