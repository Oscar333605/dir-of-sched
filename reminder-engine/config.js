// 提醒引擎配置。敏感配置（SMTP 服务器/账号/授权码等）从 .env 文件读取，避免明文硬编码到代码中。
// .env 已加入 .gitignore，不会随代码泄露。字段含义见 reminder-engine/.env.example。
//
// 关键：用 path 明确指定 .env 的绝对路径（相对于本文件所在目录），
// 避免因「工作目录(cwd)不同」导致 dotenv 找不到 .env——例如调度器从项目根目录 D:\Dir_of_Sche
// 运行 node reminder-engine/sweep.js 时，cwd 是根目录而非 reminder-engine/，默认加载会失败。
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '.env') })

// 布尔开关：SMTP 是否启用（EMAIL_ENABLED=true 时启用）
const emailEnabled = (process.env.EMAIL_ENABLED || 'true') !== 'false'

module.exports = {
  // 微信订阅消息（用于「微信消息」提醒渠道）
  wechat: {
    appid: '',      // 小程序 AppID（微信公众平台 → 开发管理 → 开发设置）
    secret: process.env.WECHAT_SECRET || '', // 小程序 AppSecret（建议用环境变量）
    // 订阅消息模板 ID：在微信公众平台「功能 → 订阅消息」创建后填入
    templates: {
      registration_start: '', // 报名开始提醒模板
      registration_ddl: '', // 报名截止提醒模板
      before_3d: '',        // 活动前三天提醒模板
      before_1d: '',        // 活动前一天提醒模板
      day_2h: '',           // 活动当天两小时前提醒模板
      task_ddl: ''          // 任务截止提醒模板
    },
    // 小程序环境：formal=正式版 / trial=试用版 / developer=开发版
    miniprogram_state: 'formal'
  },

  // 邮件提醒渠道（SMTP）。全部参数从 .env 读取：
  //   EMAIL_ENABLED  是否启用（默认 true）
  //   EMAIL_HOST     SMTP 服务器地址
  //   EMAIL_PORT     SMTP 端口
  //   EMAIL_SECURE   是否 SSL（465 为 true，587 为 false）
  //   EMAIL_USER     发件邮箱账号
  //   EMAIL_PASS     发件邮箱授权码/密码
  //   EMAIL_FROM     发件人显示名（可选）
  email: {
    enabled: emailEnabled,
    host: process.env.EMAIL_HOST || 'smtp.qiye.163.com',
    port: parseInt(process.env.EMAIL_PORT || '465', 10),
    secure: (process.env.EMAIL_SECURE || 'true') !== 'false',
    user: process.env.EMAIL_USER || 'you@example.com',
    pass: process.env.EMAIL_PASS || '',
    from: process.env.EMAIL_FROM || '日程助手 <you@example.com>'
  },

  // 短信提醒渠道（暂不接入，留接口）。接入时填密钥并把 channels/sms.js 的 sendSms 实现替换为对应服务商。
  sms: {
    enabled: false,
    provider: 'tencent',   // tencent | aliyun | custom
    secretId: '',
    secretKey: '',
    sdkAppId: '',
    signName: '',
    templates: {
      registration_start: '',
      registration_ddl: '',
      before_3d: '',
      before_1d: '',
      day_2h: '',
      task_ddl: ''
    }
  },

  // 运行监控与告警（供 lib/monitor.js 使用）。
  //   webhookUrl  告警推送地址（企业微信/钉钉/飞书群机器人或自建告警服务）。留空则不推送，仅落本地日志。
  //   告警阈值见 lib/monitor.js 的 ALERT_THRESHOLDS。
  alerts: {
    webhookUrl: process.env.ALERT_WEBHOOK_URL || ''
  }
}
