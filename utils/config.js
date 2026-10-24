// 业务配置。发布前请按需填写。
module.exports = {
  // 订阅消息模板 ID：在微信公众平台「功能 → 订阅消息」中创建模板后，把模板 ID 填到对应项。
  // 留空表示该类型提醒暂不使用微信订阅消息渠道。
  SUBSCRIPTION_TEMPLATES: {
    registration_start: '', // 报名开始提醒
    registration_ddl: '', // 报名截止提醒
    before_3d: '',        // 活动开始前三天提醒
    before_1d: '',        // 活动开始前一天提醒
    day_2h: '',           // 活动当天开始前两小时提醒
    task_ddl: ''          // 任务截止提醒
  },
  // 报名开始前提前多久提醒（分钟）
  REGISTRATION_START_LEAD_MINUTES: 5,
  // 报名截止前提前多久提醒（小时）
  REGISTRATION_LEAD_HOURS: 24,
  // 任务截止前提前多久提醒（小时）
  TASK_DDL_LEAD_HOURS: 24,
  // 提醒引擎地址（可选）。用于收集微信 openid 以发送订阅消息，例如 'https://your-engine.example.com'。
  // 留空则跳过 openid 收集，微信订阅消息渠道将不可用（邮件渠道不受影响）。
  ENGINE_BASE_URL: ''
}
