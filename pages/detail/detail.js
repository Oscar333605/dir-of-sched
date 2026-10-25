const { cloud } = require('../../utils/cloud')
const { formatDateTime, reminderTypeLabel, relativeUntil } = require('../../utils/format')
const { parseToDate } = require('../../utils/datetime')
const { deleteEvent } = require('../../utils/event')

Page({
  data: {
    id: null,
    loading: true,
    event: null,
    reminders: [],
    ddlLabel: '',
    ddlPassed: false,
    regStartLabel: '',
        regConfirmed: false,
    completed: false,
    terminated: false,
    completedDate: '',   // 周期任务的「当天完成」标记（YYYY-MM-DD），用于展示与撤销
    todayStr: ''         // 今天的日期串（供 WXML 比较）
  },

  onLoad(options) {
    // id 可能带类型前缀或被解析为字符串，统一转成数字以匹配 BIGINT 主键
    const raw = String(options.id || '').replace(/\D/g, '')
    this.setData({ id: raw ? Number(raw) : null })
  },

  onShow() {
    this.load()
  },

  async load() {
    if (!this.data.id) return
    const { data: event, error } = await cloud.database
      .from('events').select('*').eq('id', this.data.id).single()
    if (error || !event) {
      wx.showToast({ title: '活动不存在', icon: 'none' })
      this.setData({ loading: false })
      return
    }
    const { data: reminders } = await cloud.database
      .from('reminders').select('*').eq('event_id', event.id).order('trigger_at', { ascending: true })

    const decorated = (reminders || []).map(function (r) {
      return {
        id: r.id,
        typeLabel: reminderTypeLabel(r.type),
        triggerLabel: formatDateTime(r.trigger_at),
        relLabel: relativeUntil(r.trigger_at),
        sent: r.status === 'sent',
        isDdl: r.type === 'registration_ddl'
      }
    })

    let ddlLabel = ''
    let ddlPassed = false
    let regStartLabel = ''
    if (event.has_registration && event.registration_start_time) {
      regStartLabel = formatDateTime(event.registration_start_time)
    }
    if (event.has_registration && event.registration_deadline) {
      ddlLabel = formatDateTime(event.registration_deadline)
      const ddl = parseToDate(event.registration_deadline)
      ddlPassed = ddl ? ddl.getTime() <= Date.now() : false
    }

    this.setData({
      loading: false,
      event: {
        id: event.id,
        name: event.name,
        location: event.location || '',
        note: event.note || '',
        eventType: event.event_type || 'activity',
        taskContent: event.task_content || '',
        taskDdlLabel: event.task_ddl ? formatDateTime(event.task_ddl) : '',
        recurring: event.recurrence_rule === 'daily' || event.is_recurring === true,
        remindOnce: event.recurrence_rule === 'once',
        reminderLabel: event.reminder_time ? formatDateTime(event.reminder_time) : '',
        startLabel: formatDateTime(event.start_time),
        endLabel: event.end_time ? formatDateTime(event.end_time) : '',
        hasRegistration: event.has_registration === true,
        sourceType: event.source_type
      },
      reminders: decorated,
      regStartLabel: regStartLabel,
      ddlLabel: ddlLabel,
      ddlPassed: ddlPassed,
      regConfirmed: event.registration_confirmed === true,
      completed: event.status === 'completed',
      terminated: event.terminated === true,
      completedDate: event.completed_date || '',
      todayStr: this.todayStr()
    })
  },

  // 进入编辑页
  goEdit() {
    const type = this.data.event && this.data.event.eventType === 'task' ? 'task' : 'activity'
    wx.navigateTo({ url: '/pages/add/add?type=' + type + '&id=' + this.data.id })
  },

  // 判断当前是否为周期任务（每天重复）
  isRecurring() {
    const e = this.data.event
    return !!(e && (e.recurring === true))
  },

  // 今天的本地日期字符串 YYYY-MM-DD（用于周期任务「当天完成」标记）
  todayStr() {
    const d = new Date()
    const p = function (n) { return n < 10 ? '0' + n : '' + n }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  },

  // 停止某事件的后续提醒：删除其所有未发送（pending）的提醒，使其不再触发、也不再被调度器续期。
  async stopPendingReminders() {
    await cloud.database.from('reminders').delete().eq('event_id', this.data.id)
  },

  // 手动标记完成。
  // 语义区分：
  //   - 周期任务（recurrence_rule='daily'）：仅标记「当天完成」，写入 completed_date（当天日期），
  //     保持 status='active'、不清除每日提醒；第二天该任务仍会出现在周期任务列表中，完成标记自动失效。
  //   - 非周期任务/活动：维持原逻辑，status='completed' 并停止提醒，归入历史。
  async markCompleted() {
    if (this.data.completed) return
    const that = this
    try {
      if (this.isRecurring()) {
        // 周期任务：只记「当天完成」，不终结、不清提醒
        await cloud.database.from('events')
          .update({ completed_date: this.todayStr() })
          .eq('id', this.data.id)
        that.setData({ completedDate: this.todayStr() })
        wx.showToast({ title: '已标记今天完成', icon: 'success' })
      } else {
        await cloud.database.from('events')
          .update({ status: 'completed', completed_at: new Date().toISOString() })
          .eq('id', this.data.id)
        that.setData({ completed: true })
        wx.showToast({ title: '已标记完成', icon: 'success' })
      }
    } catch (e) {
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  },

  // 终结周期任务：停止后续每日提醒，并将任务归入历史（备查）。
  // 与「标记完成」的区别在于语义：终结表示该重复任务按设定时长（一周/一月等）到期结束。
  terminateRecurring() {
    const that = this
    wx.showModal({
      title: '终结任务',
      content: '终结后该任务将停止后续每天提醒，并归入历史日程备查。确定终结吗？',
      confirmText: '终结',
      confirmColor: '#ef4444',
      success(res) {
        if (!res.confirm) return
        that.doTerminate()
      }
    })
  },

  async doTerminate() {
    try {
      await this.stopPendingReminders()
      await cloud.database.from('events')
        .update({ status: 'completed', completed_at: new Date().toISOString(), terminated: true })
        .eq('id', this.data.id)
      this.setData({ completed: true, terminated: true })
      wx.showToast({ title: '已终结，归入历史', icon: 'success' })
    } catch (e) {
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  },

  // 撤销完成。
  // 语义区分：
  //   - 周期任务且「仅当天完成」（未终结）：清空 completed_date，任务保持 active、提醒不变。
  //   - 周期任务且「已终结」或非周期任务：恢复为 active，并重建后续提醒（终结/完成曾停过提醒）。
  unmarkCompleted() {
    const that = this
    const isRecurring = this.isRecurring()
    const isTerminated = this.data.terminated === true
    // 只有「当天完成（未终结）」的周期任务走「轻量撤销」
    const lightUndo = isRecurring && !isTerminated && !this.data.completed
    wx.showModal({
      title: '撤销完成',
      content: lightUndo ? '撤销「今天完成」标记？' : '将该日程恢复为未完成状态？',
      success(res) {
        if (!res.confirm) return
        if (lightUndo) {
          // 周期任务：仅清空当天完成标记
          cloud.database.from('events')
            .update({ completed_date: null })
            .eq('id', that.data.id)
            .then(function () {
              that.setData({ completedDate: '' })
              wx.showToast({ title: '已撤销', icon: 'success' })
            })
            .catch(function () {
              wx.showToast({ title: '操作失败', icon: 'none' })
            })
          return
        }
        cloud.database.from('events')
          .update({ status: 'active', completed_at: null, terminated: false, completed_date: null })
          .eq('id', that.data.id)
          .then(async function () {
            // 周期任务恢复后，重建后续每日提醒
            if (that.isRecurring()) {
              const { computeReminders } = require('../../utils/reminder')
              const { data: ev } = await cloud.database.from('events').select('*').eq('id', that.data.id).single()
              if (ev) {
                await cloud.database.from('reminders').delete().eq('event_id', that.data.id)
                const reminders = computeReminders(ev)
                if (reminders.length > 0) {
                  const rows = reminders.map(function (r) {
                    return { event_id: that.data.id, type: r.type, trigger_at: r.triggerAt }
                  })
                  await cloud.database.from('reminders').insert(rows)
                }
              }
            }
            that.setData({ completed: false, terminated: false, completedDate: '' })
            wx.showToast({ title: '已恢复', icon: 'success' })
          })
          .catch(function () {
            wx.showToast({ title: '操作失败', icon: 'none' })
          })
      }
    })
  },

  async confirmRegistration() {
    if (this.data.regConfirmed) return
    const { data, error } = await cloud.database
      .from('events').update({ registration_confirmed: true }).eq('id', this.data.id).select()
    if (error) {
      wx.showToast({ title: '操作失败', icon: 'none' })
      return
    }
    this.setData({ regConfirmed: true })
    wx.showToast({ title: '已确认报名', icon: 'success' })
  },

  cancelRegistration() {
    const that = this
    wx.showModal({
      title: '撤销确认',
      content: '确定将报名状态改为未完成吗？',
      success(res) {
        if (!res.confirm) return
        cloud.database.from('events').update({ registration_confirmed: false }).eq('id', that.data.id).then(function () {
          that.setData({ regConfirmed: false })
        })
      }
    })
  },

  deleteEvent() {
    const that = this
    wx.showModal({
      title: '删除活动',
      content: '删除后该活动及其提醒将无法恢复，确定删除吗？',
      success(res) {
        if (!res.confirm) return
        that.doDelete()
      }
    })
  },

  async doDelete() {
    const id = this.data.id
    if (!id) {
      wx.showToast({ title: '缺少活动 ID', icon: 'none' })
      return
    }
    const { error } = await deleteEvent(id)
    if (error) {
      wx.showToast({ title: '删除失败', icon: 'none' })
      return
    }
    // 空数组可能表示 RLS 过滤或行不存在，但提醒已删，仍按成功处理并返回列表
    wx.showToast({ title: '已删除', icon: 'success' })
    setTimeout(function () { wx.navigateBack() }, 600)
  }
})
