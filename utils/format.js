const { parseToDate } = require('./datetime')

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

// 把 ISO 时间字符串格式化为 'YYYY-MM-DD HH:mm'（统一经 parseToDate，避免无时区串被误当 UTC）
function formatDateTime(iso) {
  const d = parseToDate(iso)
  if (!d) return ''
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

function formatDate(iso) {
  const d = parseToDate(iso)
  if (!d) return ''
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

// 只取时分 HH:mm（用于周期任务展示每天的提醒时刻）
function formatTimeOnly(iso) {
  const d = parseToDate(iso)
  if (!d) return ''
  return pad(d.getHours()) + ':' + pad(d.getMinutes())
}

// 距离某个时间还有多久（用于展示，如 '3 天后' / '2 小时后'）
function relativeUntil(iso) {
  const d = parseToDate(iso)
  if (!d) return ''
  const diff = d.getTime() - Date.now()
  if (diff < 0) return '已开始'
  const minutes = Math.floor(diff / 60000)
  if (minutes < 60) return minutes + ' 分钟后'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + ' 小时后'
  const days = Math.floor(hours / 24)
  return days + ' 天后'
}

// 提醒类型 → 中文名
function reminderTypeLabel(type) {
  const map = {
    registration_start: '报名开始提醒',
    registration_ddl: '报名截止提醒',
    before_3d: '活动前三天提醒',
    before_1d: '活动前一天提醒',
    day_2h: '活动当天两小时前提醒',
    task_ddl: '任务截止提醒',
    task_reminder: '任务提醒',
    task_daily: '每日任务提醒'
  }
  return map[type] || type
}

module.exports = { formatDateTime, formatDate, formatTimeOnly, relativeUntil, reminderTypeLabel }
