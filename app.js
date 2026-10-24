App({
  // 应用启动时不发起任何云请求，避免在未登录状态下触发受保护接口。
  // 会话管理统一走 utils/auth.js 的 getSession/loginWithWechat，无需全局缓存。
})
