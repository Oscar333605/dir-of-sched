const { cloud } = require('../../utils/cloud')
const auth = require('../../utils/auth')
const { formatDateTime, formatTimeOnly, relativeUntil } = require('../../utils/format')
const { parseToDate } = require('../../utils/datetime')

function toMs(iso) {
  const d = parseToDate(iso)
  return d ? d.getTime() : NaN
}

Page({
  data: {
    loggedIn: false,
    email: '',
    savingEmail: false,
    // 历史日程三类分区
    histActivity: [],   // 已结束/已完成的活动
    histTask: [],       // 已完成的短期任务
    histRecurring: []   // 已完成的周期任务（含已终结）
  },

  onShow() {
    this.load()
  },

  async load() {
    const session = await auth.getSession()
    this.setData({ loggedIn: !!session })
    if (session) {
      const { data } = await cloud.database.from('user_settings').select('*').maybeSingle()
      this.setData({ email: (data && data.email) || '' })
      await this.loadHistory()
    }
  },

  // 加载历史日程：活动/任务/周期任务三类分区
  async loadHistory() {
    const { data, error } = await cloud.database
      .from('events')
      .select('*')
      .order('start_time', { ascending: false })
    if (error) return

    const now = Date.now()
    const histActivity = []
    const histTask = []
    const histRecurring = []
    const rows = data || []

    rows.forEach(function (e) {
      const isRecurring = e.recurrence_rule === 'daily' || e.is_recurring === true
      if (e.event_type === 'task') {
        // 只收集已完成/已终结的任务
        if (e.status !== 'completed') return
        if (isRecurring) histRecurring.push(e)
        else histTask.push(e)
        return
      }
      // 活动：已结束（含已完成）
      const endMs = e.end_time ? toMs(e.end_time) : toMs(e.start_time)
      const isDone = e.status === 'completed' || (endMs < now)
      if (isDone) histActivity.push(e)
    })

    this.setData({
      histActivity: this.decorateActivity(histActivity),
      histTask: this.decorateTask(histTask),
      histRecurring: this.decorateRecurring(histRecurring)
    })
  },

  decorateActivity(list) {
    return list.map(function (e) {
      return {
        id: e.id,
        name: e.name,
        location: e.location || '',
        startLabel: formatDateTime(e.start_time),
        endLabel: e.end_time ? formatDateTime(e.end_time) : '',
        completed: e.status === 'completed'
      }
    })
  },

  decorateTask(list) {
    return list.map(function (e) {
      return {
        id: e.id,
        name: e.name,
        content: e.task_content || '',
        ddlLabel: e.task_ddl ? formatDateTime(e.task_ddl) : '',
        completedAt: e.completed_at ? formatDateTime(e.completed_at) : '',
        terminated: e.terminated === true
      }
    })
  },

  decorateRecurring(list) {
    return list.map(function (e) {
      return {
        id: e.id,
        name: e.name,
        content: e.task_content || '',
        reminderTimeLabel: e.reminder_time ? formatTimeOnly(e.reminder_time) : '',
        completedAt: e.completed_at ? formatDateTime(e.completed_at) : '',
        terminated: e.terminated === true
      }
    })
  },

  // 跳转到详情
  goDetail(e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id })
  },

  doLogin() {
    auth.loginWithWechat().then(function () {
      wx.reLaunch({ url: '/pages/index/index' })
    }).catch(function (e) {
      wx.showToast({ title: (e && e.message) || '登录失败', icon: 'none' })
    })
  },

  onEmailInput(e) {
    this.setData({ email: e.detail.value })
  },

  async saveEmail() {
    const email = (this.data.email || '').trim()
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      wx.showToast({ title: '邮箱格式不正确', icon: 'none' })
      return
    }
    if (this.data.savingEmail) return
    this.setData({ savingEmail: true })
    try {
      const session = await auth.getSession()
      if (!session) throw new Error('请先登录')
      const { data } = await cloud.database.from('user_settings').select('*').maybeSingle()
      if (data) {
        const r = await cloud.database.from('user_settings').update({ email: email }).eq('owner_id', session.user.id).select()
        if (r.error) throw r.error
      } else {
        const r = await cloud.database.from('user_settings').insert({ owner_id: session.user.id, email: email }).select()
        if (r.error) throw r.error
      }
      wx.showToast({ title: '已保存', icon: 'success' })
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '保存失败', icon: 'none' })
    } finally {
      this.setData({ savingEmail: false })
    }
  }
})
