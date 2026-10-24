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

async function sendEmail(to, subject, html) {
  const c = config.email
  if (!c.enabled || !c.host || !to) {
    return { channel: 'email', status: 'skipped', reason: 'not configured' }
  }
  try {
    await getTransporter().sendMail({ from: c.from || c.user, to: to, subject: subject, html: html })
    return { channel: 'email', status: 'ok' }
  } catch (e) {
    return { channel: 'email', status: 'fail', reason: e.message }
  }
}

module.exports = { sendEmail }
