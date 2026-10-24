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
    completed: false
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
      completed: event.status === 'completed'
    })
  },

  // 进入编辑页
  goEdit() {
    const type = this.data.event && this.data.event.eventType === 'task' ? 'task' : 'activity'
    wx.navigateTo({ url: '/pages/add/add?type=' + type + '&id=' + this.data.id })
  },

  // 手动标记完成（历史回溯用）
  markCompleted() {
    if (this.data.completed) return
    const that = this
    cloud.database.from('events')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', this.data.id)
      .then(function () {
        that.setData({ completed: true })
        wx.showToast({ title: '已标记完成', icon: 'success' })
      })
      .catch(function () {
        wx.showToast({ title: '操作失败', icon: 'none' })
      })
  },

  // 撤销完成，恢复为进行中/待办
  unmarkCompleted() {
    const that = this
    wx.showModal({
      title: '撤销完成',
      content: '将该日程恢复为未完成状态？',
      success(res) {
        if (!res.confirm) return
        cloud.database.from('events')
          .update({ status: 'active', completed_at: null })
          .eq('id', that.data.id)
          .then(function () {
            that.setData({ completed: false })
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
