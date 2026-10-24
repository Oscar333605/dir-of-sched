// 根据提醒类型生成各渠道的消息内容。
function pad(n) { return n < 10 ? '0' + n : '' + n }

function fmt(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

const LABELS = {
  registration_start: '报名开始提醒',
  registration_ddl: '报名截止提醒',
  before_3d: '活动前三天提醒',
  before_1d: '活动前一天提醒',
  day_2h: '活动当天两小时前提醒',
  task_ddl: '任务截止提醒',
  task_reminder: '任务提醒',
  task_daily: '每日任务提醒'
}

// r: { type, event_name, start_time, location, note, registration_start_time, registration_deadline, task_content, task_ddl }
function buildMessages(type, r) {
  const name = r.event_name || '未命名活动'
  const start = fmt(r.start_time)
  const loc = r.location || ''
  const note = r.note || ''
  const regStart = fmt(r.registration_start_time)
  const ddl = fmt(r.registration_deadline)
  const taskDdl = fmt(r.task_ddl)

  let emailSubject = ''
  let emailBody = ''
  let smsText = ''
  let wechatData = {}

  // 备注追加片段（活动提醒邮件中附加着装要求等说明）
  const noteHtml = note ? '<p><b>备注：</b>' + note + '</p>' : ''

  if (type === 'registration_start') {
    emailSubject = '【报名提醒】' + name + ' 报名即将开始'
    emailBody = '<p>「' + name + '」的报名将于 <b>' + regStart + '</b> 开始，请及时报名。</p>' +
      '<p>报名成功后，请回到「Dir of Sched」小程序，在活动详情中点击「我已完成报名」确认。</p>' + noteHtml
    smsText = '【报名提醒】' + name + ' 报名将于 ' + regStart + ' 开始，请及时报名，报名成功后请在小程序确认。'
    wechatData = {
      thing1: { value: name.slice(0, 20) },
      time2: { value: regStart }
    }
  } else if (type === 'registration_ddl') {
    emailSubject = '【报名提醒】' + name + ' 报名即将截止'
    emailBody = '<p>「' + name + '」的报名将于 <b>' + ddl + '</b> 截止，请尽快完成报名。</p>' +
      '<p>完成后请回到「Dir of Sched」小程序，在活动详情中点击「我已完成报名」确认。</p>' + noteHtml
    smsText = '【报名提醒】' + name + ' 报名将于 ' + ddl + ' 截止，请尽快完成报名。'
    wechatData = {
      thing1: { value: name.slice(0, 20) },
      time2: { value: ddl }
    }
  } else if (type === 'before_3d') {
    emailSubject = '【活动提醒】' + name + ' 将于 3 天后开始'
    emailBody = '<p>「' + name + '」将于 <b>' + start + '</b> 开始' + (loc ? '，地点：' + loc : '') + '。</p><p>请提前安排时间。</p>' + noteHtml
    smsText = '【活动提醒】' + name + ' 将于 3 天后（' + start + '）开始' + (loc ? '，地点：' + loc : '') + '。'
    wechatData = {
      thing1: { value: name.slice(0, 20) },
      time2: { value: start }
    }
  } else if (type === 'before_1d') {
    emailSubject = '【活动提醒】' + name + ' 将于明天开始'
    emailBody = '<p>「' + name + '」将于明天 <b>' + start + '</b> 开始' + (loc ? '，地点：' + loc : '') + '。</p><p>请提前准备。</p>' + noteHtml
    smsText = '【活动提醒】' + name + ' 将于明天（' + start + '）开始' + (loc ? '，地点：' + loc : '') + '。'
    wechatData = {
      thing1: { value: name.slice(0, 20) },
      time2: { value: start }
    }
  } else if (type === 'task_ddl') {
    emailSubject = '【任务提醒】' + name + ' 即将截止'
    emailBody = '<p>任务「' + name + '」将于 <b>' + taskDdl + '</b> 截止。</p>' +
      (r.task_content ? '<p><b>工作内容：</b>' + r.task_content + '</p>' : '') + noteHtml
    smsText = '【任务提醒】' + name + ' 将于 ' + taskDdl + ' 截止，请及时完成。'
    wechatData = {
      thing1: { value: name.slice(0, 20) },
      time2: { value: taskDdl }
    }
  } else if (type === 'task_reminder') {
    // 用户自定义提醒时间（每日/一次性）：在指定时刻提醒，无截止语义
    emailSubject = '【任务提醒】' + name
    emailBody = '<p>提醒你：任务「' + name + '」。</p>' +
      (r.task_content ? '<p><b>工作内容：</b>' + r.task_content + '</p>' : '') +
      (r.task_ddl ? '<p><b>截止时间：</b>' + taskDdl + '</p>' : '') + noteHtml
    smsText = '【任务提醒】' + name + '，请及时处理。'
    wechatData = {
      thing1: { value: name.slice(0, 20) },
      time2: { value: taskDdl || start }
    }
  } else if (type === 'task_daily') {
    // 周期任务（每天重复）的每日提醒
    emailSubject = '【每日任务】' + name
    emailBody = '<p>今日待办：任务「' + name + '」。</p>' +
      (r.task_content ? '<p><b>工作内容：</b>' + r.task_content + '</p>' : '') +
      (r.task_ddl ? '<p><b>截止时间：</b>' + taskDdl + '</p>' : '') + noteHtml
    smsText = '【每日任务】' + name + '，今日待办。'
    wechatData = {
      thing1: { value: name.slice(0, 20) },
      time2: { value: taskDdl || start }
    }
  } else {
    emailSubject = '【活动提醒】' + name + ' 将于 2 小时后开始'
    emailBody = '<p>「' + name + '」将于 2 小时后（<b>' + start + '</b>）开始' + (loc ? '，地点：' + loc : '') + '。</p><p>注意时间，别迟到。</p>' + noteHtml
    smsText = '【活动提醒】' + name + ' 将于 2 小时后（' + start + '）开始' + (loc ? '，地点：' + loc : '') + '。'
    wechatData = {
      thing1: { value: name.slice(0, 20) },
      time2: { value: start }
    }
  }

  return { label: LABELS[type] || type, emailSubject, emailBody, smsText, wechatData }
}

module.exports = { buildMessages, fmt }
