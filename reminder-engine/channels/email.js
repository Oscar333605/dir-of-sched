// 邮件渠道（SMTP）。依赖 nodemailer：cd reminder-engine && npm install
// 复用 transporter 连接，避免每次发送都重建 SMTP 连接。
const config = require('../config')

let _transporter = null

function getTransporter() {
  if (_transporter) return _transporter
  const nodemailer = require('nodemailer')
  _transporter = nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.secure,
    auth: config.email.user ? { user: config.email.user, pass: config.email.pass } : undefined
  })
  return _transporter
}

// 重置 SMTP 连接（供监控自愈调用：连接异常时释放旧连接，下次自动重建）
function resetTransporter() {
  _transporter = null
}

async function sendEmail(to, subject, html) {
  const c = config.email
  if (!c.enabled || !c.host || !to) {
    return { channel: 'email', status: 'skipped', reason: 'not configured' }
  }
  try {
    await getTransporter().sendMail({ from: c.from || c.user, to: to, subject: subject, html: html })
    return { channel: 'email', status: 'ok' }
  } catch (e) {
    // 标注错误类型，便于监控模块决定是否触发「重建连接」自愈
    const msg = e && e.message ? e.message : ''
    const isConnFail = /ECONN|ETIMEDOUT|socket|timeout|ECONNRESET|ESOCKET/i.test(msg)
    return { channel: 'email', status: 'fail', reason: msg, errType: isConnFail ? 'email.smtp_conn_fail' : 'email.send_fail' }
  }
}

module.exports = { sendEmail, resetTransporter }
