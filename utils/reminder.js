const config = require('./config')

// 根据活动/任务信息计算所有需要提醒的时间点。
// 返回数组，每项 { type, triggerAt(ISO), label }。
function computeReminders(event) {
  const list = []

  // 任务类型：截止时间提醒 + 自定义提醒时间；周期任务滚动生成每日提醒
  if (event.event_type === 'task') {
    return computeTaskReminders(event)
  }

  const start = new Date(event.start_time)
  if (isNaN(start.getTime())) return list

  // 1) 报名开始提醒：报名开始前 5 分钟提醒，并引导用户报名成功后回小程序确认
  if (event.has_registration && event.registration_start_time) {
    const startReg = new Date(event.registration_start_time)
    if (!isNaN(startReg.getTime())) {
      const leadMin = config.REGISTRATION_START_LEAD_MINUTES || 5
      const trigger = new Date(startReg.getTime() - leadMin * 60 * 1000)
      list.push({ type: 'registration_start', triggerAt: trigger.toISOString() })
    }
  }

  // 2) 报名截止提醒：截止前 REGISTRATION_LEAD_HOURS 小时
  if (event.has_registration && event.registration_deadline) {
    const ddl = new Date(event.registration_deadline)
    if (!isNaN(ddl.getTime())) {
      const lead = config.REGISTRATION_LEAD_HOURS || 24
      const trigger = new Date(ddl.getTime() - lead * 3600 * 1000)
      list.push({ type: 'registration_ddl', triggerAt: trigger.toISOString() })
    }
  }

  // 3) 活动开始前三天，当天 07:00
  const d3 = new Date(start.getTime())
  d3.setDate(d3.getDate() - 3)
  d3.setHours(7, 0, 0, 0)
  list.push({ type: 'before_3d', triggerAt: d3.toISOString() })

  // 4) 活动开始前一天，当天 23:00
  const d1 = new Date(start.getTime())
  d1.setDate(d1.getDate() - 1)
  d1.setHours(23, 0, 0, 0)
  list.push({ type: 'before_1d', triggerAt: d1.toISOString() })

  // 5) 活动当天，开始前两小时
  const d2h = new Date(start.getTime() - 2 * 3600 * 1000)
  list.push({ type: 'day_2h', triggerAt: d2h.toISOString() })

  // 只保留未过期的时间点
  const now = Date.now()
  return list.filter(function (r) { return new Date(r.triggerAt).getTime() > now })
}

// 任务提醒计算：截止提醒 + 自定义提醒时间 + 周期任务滚动。
function computeTaskReminders(event) {
  const list = []
  const now = Date.now()
  const isRecurring = event.is_recurring === true && event.recurrence_rule === 'daily'

  // 1) 截止时间提醒（可选）：截止前 lead 小时
  if (event.task_ddl) {
    const ddl = new Date(event.task_ddl)
    if (!isNaN(ddl.getTime())) {
      const lead = config.TASK_DDL_LEAD_HOURS || 24
      const trigger = new Date(ddl.getTime() - lead * 3600 * 1000)
      list.push({ type: 'task_ddl', triggerAt: trigger.toISOString() })
    }
  }

  // 2) 周期任务（每天重复）：生成「下一次」的每日提醒。
  //    规则：取 reminder_time 的时分（未设则默认 09:00），计算今天该时刻，若已过则推到明天。
  //    每次触发后由调度器滚动续期（生成再下一天），形成每日循环。
  if (isRecurring) {
    let h = 9
    let m = 0
    if (event.reminder_time) {
      const rt = new Date(event.reminder_time)
      if (!isNaN(rt.getTime())) {
        h = rt.getHours()
        m = rt.getMinutes()
      }
    }
    const next = new Date()
    next.setHours(h, m, 0, 0)
    if (next.getTime() <= now) {
      next.setDate(next.getDate() + 1)
    }
    list.push({ type: 'task_daily', triggerAt: next.toISOString() })
  } else if (event.reminder_time) {
    // 3) 非周期任务的自定义提醒时间（可选）：在指定时刻发一封提醒邮件（一次性）
    const rt = new Date(event.reminder_time)
    if (!isNaN(rt.getTime())) {
      list.push({ type: 'task_reminder', triggerAt: rt.toISOString() })
    }
  }

  // 只保留未过期的时间点
  return list.filter(function (r) { return new Date(r.triggerAt).getTime() > now })
}

module.exports = { computeReminders, computeTaskReminders }
