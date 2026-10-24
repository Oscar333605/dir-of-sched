const { cloud } = require('../../utils/cloud')
const auth = require('../../utils/auth')
const { formatDateTime, relativeUntil } = require('../../utils/format')
const { parseToDate } = require('../../utils/datetime')
const { deleteEvent } = require('../../utils/event')

// 把一个时间字段解析为毫秒时间戳；无效时返回 NaN。
function toMs(iso) {
  const d = parseToDate(iso)
  return d ? d.getTime() : NaN
}

Page({
  data: {
    loggedIn: false,
    loading: true,
    tab: 'activity',   // activity | task
    upcoming: [],
    ongoing: [],
    past: [],
    // 任务列表
    taskPending: [],
    taskDone: []
  },

  onShow() {
    this.refresh()
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab === this.data.tab) return
    this.setData({ tab: tab })
  },

  async refresh() {
    this.setData({ loading: true })
    let session = await auth.getSession()
    if (!session) {
      // 静默尝试一次微信登录
      try {
        session = await auth.loginWithWechat()
      } catch (e) {
        session = null
      }
    }
    if (!session) {
      this.setData({ loggedIn: false, loading: false, upcoming: [], past: [], taskPending: [], taskDone: [] })
      return
    }
    this.setData({ loggedIn: true })
    await this.loadEvents()
  },

  async loadEvents() {
    const { data, error } = await cloud.database
      .from('events')
      .select('*')
      .order('start_time', { ascending: true })
    if (error) {
      wx.showToast({ title: '加载失败', icon: 'none' })
      this.setData({ loading: false })
      return
    }
    const now = Date.now()
    const upcoming = []   // 未开始
    const ongoing = []    // 已开始、未结束
    const past = []       // 历史（已结束 / 已完成）
    const taskPending = [] // 任务未完成
    const taskDone = []    // 任务已完成
    const rows = data || []
    rows.forEach(function (e) {
      // 任务类型单独归类
      if (e.event_type === 'task') {
        if (e.status === 'completed') taskDone.push(e)
        else taskPending.push(e)
        return
      }
      // 判定「是否结束」的基准：优先结束时间，无结束时间则用开始时间
      const endMs = e.end_time ? toMs(e.end_time) : toMs(e.start_time)
      const startMs = toMs(e.start_time)
      const isDone = e.status === 'completed' || (endMs < now)

      if (isDone) {
        past.push(e)
      } else if (startMs >= now) {
        upcoming.push(e)
      } else {
        ongoing.push(e)   // 已开始但未结束
      }
    })
    function decorate(list) {
      return list.map(function (e) {
        const endMs = e.end_time ? toMs(e.end_time) : toMs(e.start_time)
        return {
          id: e.id,
          name: e.name,
          location: e.location || '',
          note: e.note || '',
          startLabel: formatDateTime(e.start_time),
          endLabel: e.end_time ? formatDateTime(e.end_time) : '',
          relLabel: relativeUntil(e.start_time),
          hasReg: e.has_registration === true,
          hasDdl: !!(e.has_registration && e.registration_deadline),
          completed: e.status === 'completed',
          ended: e.status !== 'completed' && endMs < Date.now()
        }
      })
    }
    function decorateTask(list) {
      return list.map(function (e) {
        return {
          id: e.id,
          name: e.name,
          content: e.task_content || '',
          note: e.note || '',
          ddlLabel: formatDateTime(e.task_ddl),
          relLabel: relativeUntil(e.task_ddl),
          recurring: e.is_recurring === true,
          reminderLabel: e.reminder_time ? formatDateTime(e.reminder_time) : '',
          completed: e.status === 'completed',
          overdue: e.status !== 'completed' && e.task_ddl && toMs(e.task_ddl) < Date.now()
        }
      })
    }
    this.setData({
      upcoming: decorate(upcoming),
      ongoing: decorate(ongoing),
      past: decorate(past),
      taskPending: decorateTask(taskPending),
      taskDone: decorateTask(taskDone),
      loading: false
    })
  },

  doLogin() {
    auth.loginWithWechat().then(function () {
      // 登录成功后由 onShow 重新拉取
      wx.reLaunch({ url: '/pages/index/index' })
    }).catch(function (e) {
      wx.showToast({ title: (e && e.message) || '登录失败', icon: 'none' })
    })
  },

  goAdd() {
    if (!this.data.loggedIn) {
      this.doLogin()
      return
    }
    // 根据当前 Tab 进入对应新增页
    if (this.data.tab === 'task') {
      wx.navigateTo({ url: '/pages/add/add?type=task' })
    } else {
      wx.navigateTo({ url: '/pages/add/add?type=activity' })
    }
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id })
  },

  // 长按卡片删除日程
  onLongPressDelete(e) {
    const id = e.currentTarget.dataset.id
    const name = e.currentTarget.dataset.name
    if (!id) return
    const that = this
    wx.showModal({
      title: '删除日程',
      content: '删除「' + (name || '该日程') + '」及其提醒？',
      confirmText: '删除',
      confirmColor: '#ef4444',
      success(res) {
        if (!res.confirm) return
        that.doDelete(id)
      }
    })
  },

  async doDelete(id) {
    const { error } = await deleteEvent(id)
    if (error) {
      wx.showToast({ title: '删除失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '已删除', icon: 'success' })
    this.loadEvents()
  },

  goMe() {
    wx.navigateTo({ url: '/pages/me/me' })
  }
})
