const { cloud } = require('../../utils/cloud')
const auth = require('../../utils/auth')

Page({
  data: {
    loggedIn: false,
    email: '',
    savingEmail: false
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
    }
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
        // 显式写入 owner_id，避免依赖数据库默认 auth.uid() 未生效导致归属错乱
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
