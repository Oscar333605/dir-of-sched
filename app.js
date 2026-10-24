const monitor = require('./utils/monitor')

App({
  // 应用启动时不发起任何云请求，避免在未登录状态下触发受保护接口。
  // 会话管理统一走 utils/auth.js 的 getSession/loginWithWechat，无需全局缓存。
  onLaunch() {
    // 安装运行监控：采集接口指标、页面异常，本地持久化供「监控看板」查看
    monitor.install()
  },

  onError(err) {
    // 全局 JS 运行时错误采集
    monitor.recordJsError(err || 'unknown error')
  },

  onUnhandledRejection(res) {
    // 未处理 Promise 拒绝采集
    const reason = res && (res.reason || res.message)
    monitor.recordRejection(reason || 'unknown rejection')
  }
})
