// 短信渠道（暂不接入，留接口）。
// 接入时：把 sendSms 内的占位逻辑替换为对应服务商的 API 调用（如腾讯云 SMS / 阿里云 SMS），
// 并在 config.js 的 sms 段填入密钥。接口签名保持不变，sweep.js 无需改动。
const config = require('../config')

async function sendSms(phone, type, text) {
  const c = config.sms
  if (!c.enabled || !phone) {
    return { channel: 'sms', status: 'skipped', reason: 'not configured' }
  }
  // TODO: 在此接入短信服务商，例如腾讯云 SMS：
  //   1. 用 secretId/secretKey 计算签名
  //   2. POST 到 sms.tencentcloudapi.com，SendSms
  //   3. 使用 config.sms.templates[type] 作为模板 ID，signName 作为签名
  return { channel: 'sms', status: 'skipped', reason: 'provider not implemented (placeholder)' }
}

module.exports = { sendSms }
