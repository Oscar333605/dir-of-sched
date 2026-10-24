// 微信订阅消息渠道：获取 access_token（带缓存）、发送订阅消息、jscode2session 换取 openid。
const config = require('../config')

// access_token 缓存（微信 token 有效期约 2 小时，提前 5 分钟失效）
let _tokenCache = { token: null, expiresAt: 0 }

async function getAccessToken() {
  if (!config.wechat.appid || !config.wechat.secret) return null
  // 缓存未过期则直接复用，避免高频调用触发微信限流
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt) return _tokenCache.token
  const url = 'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential' +
    '&appid=' + encodeURIComponent(config.wechat.appid) +
    '&secret=' + encodeURIComponent(config.wechat.secret)
  try {
    const res = await fetch(url)
    const j = await res.json()
    if (j.access_token) {
      const expiresIn = (j.expires_in || 7200) - 300 // 提前 5 分钟失效
      _tokenCache = { token: j.access_token, expiresAt: Date.now() + expiresIn * 1000 }
      return j.access_token
    }
    return null
  } catch (e) {
    return null
  }
}

// 使 access_token 缓存失效（供监控自愈调用：token 异常时强制重新获取）
function invalidateToken() {
  _tokenCache = { token: null, expiresAt: 0 }
}

// 发送订阅消息。openid 为用户在小程序中的 openid；data 的字段名须与订阅消息模板一致。
async function sendSubscription(openid, type, data, page) {
  const templateId = (config.wechat.templates || {})[type]
  if (!config.wechat.appid || !config.wechat.secret || !templateId || !openid) {
    return { channel: 'wechat', status: 'skipped', reason: 'not configured' }
  }
  const token = await getAccessToken()
  if (!token) {
    return { channel: 'wechat', status: 'fail', reason: 'access_token 获取失败', errType: 'wechat.access_token_fail' }
  }
  const res = await fetch('https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=' + token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      touser: openid,
      template_id: templateId,
      page: page || 'pages/index/index',
      miniprogram_state: config.wechat.miniprogram_state || 'formal',
      data: data
    })
  })
  const j = await res.json()
  if (j.errcode === 0) return { channel: 'wechat', status: 'ok' }
  return { channel: 'wechat', status: 'fail', reason: j.errmsg || ('errcode ' + j.errcode), errType: 'wechat.send_fail' }
}

// 用 wx.login 的 code 换取 openid（用于小程序收集 openid）。
async function jscode2session(code) {
  if (!config.wechat.appid || !config.wechat.secret || !code) {
    throw new Error('微信未配置或缺少 code')
  }
  const url = 'https://api.weixin.qq.com/sns/jscode2session?appid=' + encodeURIComponent(config.wechat.appid) +
    '&secret=' + encodeURIComponent(config.wechat.secret) +
    '&js_code=' + encodeURIComponent(code) +
    '&grant_type=authorization_code'
  const res = await fetch(url)
  const j = await res.json()
  if (j.errcode) throw new Error(j.errmsg || ('errcode ' + j.errcode))
  return { openid: j.openid }
}

module.exports = { getAccessToken, sendSubscription, jscode2session, invalidateToken }
