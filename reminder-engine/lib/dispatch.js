// 发送单条提醒：并发走邮件 + 微信 + 短信三个渠道，返回各渠道结果。
// 被 sweep.js（CLI 单次执行）与 server.js（常驻服务）共同复用，避免逻辑重复。
const { buildMessages } = require('./message')
const email = require('../channels/email')
const wechat = require('../channels/wechat')
const sms = require('../channels/sms')
const monitor = require('./monitor')

async function dispatchOne(r) {
  const msg = buildMessages(r.type, r)
  // 三渠道并发发送，减少串行等待
  const tasks = []
  if (r.email) tasks.push(email.sendEmail(r.email, msg.emailSubject, msg.emailBody))
  if (r.wechat_openid) tasks.push(wechat.sendSubscription(r.wechat_openid, r.type, msg.wechatData))
  if (r.phone) tasks.push(sms.sendSms(r.phone, r.type, msg.smsText))
  const results = tasks.length > 0 ? await Promise.all(tasks) : []
  if (results.length === 0) {
    results.push({ channel: 'all', status: 'skipped', reason: 'no contact info' })
  }

  // 对可自愈的失败渠道触发一次自愈（幂等、无副作用）
  for (const res of results) {
    if (res.status === 'fail' && res.errType) {
      await monitor.selfHeal(res.errType)
    }
  }

  return { reminder_id: r.reminder_id, channels: results }
}

module.exports = { dispatchOne }
