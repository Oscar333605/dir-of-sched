const { cloud } = require('../../utils/cloud')
const auth = require('../../utils/auth')
const parser = require('../../utils/parser')
const { computeReminders } = require('../../utils/reminder')
const config = require('../../utils/config')
const { splitIso, buildIso, toDateStr } = require('../../utils/datetime')

Page({
  data: {
    type: 'activity',   // activity | task
    today: '',          // 当天日期，供可选日期 picker 的 value 兜底（空值会弹不出面板）
    rawText: '',
    imageTempPath: '',
    parsing: false,
    saving: false,
    parsed: false,
    form: {
      name: '',
      location: '',
      note: '',
      startDate: '',
      startTime: '09:00',
      endDate: '',
      endTime: '18:00',
      hasRegistration: false,
      ddlDate: '',
      ddlTime: '18:00',
      regStartDate: '',
      regStartTime: '09:00',
      // 任务字段
      taskContent: '',
      taskDdlDate: '',
      taskDdlTime: '18:00',
      isRecurring: false,       // 是否每天重复
      reminderDate: '',         // 提醒时间（日期部分，可选，空=不提醒）
      reminderTime: '09:00'     // 提醒时间（时分部分）
    }
  },

  onLoad(options) {
    const type = options && options.type === 'task' ? 'task' : 'activity'
    const d = new Date()
    const patch = {
      type: type,
      today: toDateStr(d),
      'form.startDate': toDateStr(d)
    }
    // 报名开始/截止日期、任务截止日期不设默认值：留空表示「未填写」，避免把默认日期误当成真实时间存库
    if (type === 'task') {
      wx.setNavigationBarTitle({ title: '添加任务' })
    } else {
      wx.setNavigationBarTitle({ title: '添加活动' })
    }
    this.setData(patch)
  },

  onInput(e) {
    this.setData({ rawText: e.detail.value, parsed: false })
  },

  onPaste() {
    const that = this
    wx.getClipboardData({
      success(res) {
        that.setData({ rawText: res.data || '', parsed: false })
        wx.showToast({ title: '已粘贴', icon: 'none' })
      }
    })
  },

  onChooseImage() {
    const that = this
    wx.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success(res) {
        const tempPath = res.tempFilePaths && res.tempFilePaths[0]
        if (!tempPath) return
        that.setData({ imageTempPath: tempPath, parsed: false })
      }
    })
  },

  // 手动填写：跳过智能解析，直接展开表单，短文本场景更快
  onManual() {
    this.setData({ parsed: true })
  },

  // 解析：优先截图，其次文字（含公众号链接识别）
  async onParse() {
    if (this.data.parsing) return
    this.setData({ parsing: true })
    try {
      let result = null
      const raw = (this.data.rawText || '').trim()

      if (this.data.imageTempPath) {
        result = await this.parseFromImage(this.data.imageTempPath)
      } else if (raw) {
        // 公众号链接：小程序无法直接抓取外链，尝试用 LLM 判断链接内容；
        // 若模型支持联网会尽量解析，否则提示用户复制正文。
        if (parser.isArticleLink(raw)) {
          result = await this.parseFromLink(raw)
        } else if (this.data.type === 'task') {
          result = await parser.parseTask(raw)
        } else {
          result = await parser.parseText(raw)
        }
      } else {
        wx.showToast({ title: '请粘贴文字/链接或上传截图', icon: 'none' })
        this.setData({ parsing: false })
        return
      }
      this.applyParsed(result)
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '解析失败', icon: 'none' })
    } finally {
      this.setData({ parsing: false })
    }
  },

  // 解析公众号链接：把链接交给 LLM，尽量抽取其中活动信息（复用 callLLM 与日期上下文）
  async parseFromLink(link) {
    const prompt = '这是一篇微信公众号文章的链接：' + link + '\n\n请尝试根据你对这篇文章的了解或链接中的信息，抽取其中的活动信息（名称、时间、地点、报名等）。' +
      '如果无法获取文章内容，请返回一个 JSON：{"error":"无法访问文章内容，请复制文章正文后粘贴"}'
    const text = await parser.callLLM([
      { role: 'system', content: '你是公众号活动信息抽取助手。只输出 JSON。' + parser.nowContext() },
      { role: 'user', content: prompt }
    ])
    let parsed
    try {
      parsed = JSON.parse(text.match(/\{[\s\S]*\}/) ? text.match(/\{[\s\S]*\}/)[0] : text)
    } catch (e) {
      throw new Error('链接解析失败，请复制文章正文后粘贴')
    }
    if (parsed.error) {
      throw new Error('无法直接抓取公众号文章，请复制文章正文后粘贴')
    }
    return {
      name: parsed.name || '',
      start_time: parsed.start_time || '',
      end_time: parsed.end_time || '',
      location: parsed.location || '',
      note: parsed.note || '',
      has_registration: parsed.has_registration === true,
      registration_start_time: parsed.registration_start_time || '',
      registration_deadline: parsed.registration_deadline || ''
    }
  },

  async parseFromImage(tempPath) {
    const session = await auth.getSession()
    if (!session) throw new Error('请先登录')
    const fs = wx.getFileSystemManager()
    const buf = fs.readFileSync(tempPath)
    const filePath = cloud.storage.userPath(session.user.id, 'screenshots/' + Date.now() + '.png')
    const up = await cloud.storage.upload(filePath, buf, { contentType: 'image/png' })
    if (up.error) throw new Error('图片上传失败')
    let url = ''
    const signed = await cloud.storage.createSignedUrl(filePath, 600)
    if (signed && !signed.error) {
      url = typeof signed.data === 'string' ? signed.data : (signed.data && signed.data.url) || ''
    }
    return parser.parseImage(url || filePath)
  },

  applyParsed(r) {
    if (this.data.type === 'task') {
      // 任务模式：直接映射任务专用字段
      const ddl = splitIso(r.task_ddl)
      this.setData({
        parsed: true,
        'form.name': r.name || '',
        'form.taskContent': r.task_content || '',
        'form.note': r.note || '',
        'form.taskDdlDate': r.task_ddl ? ddl.date : '',
        'form.taskDdlTime': r.task_ddl ? ddl.time : this.data.form.taskDdlTime
      })
      return
    }
    const start = splitIso(r.start_time)
    const end = splitIso(r.end_time)
    const ddl = splitIso(r.registration_deadline)
    const regStart = splitIso(r.registration_start_time)
    this.setData({
      parsed: true,
      'form.name': r.name || '',
      'form.location': r.location || '',
      'form.note': r.note || '',
      'form.startDate': start.date,
      'form.startTime': start.time,
      'form.endDate': r.end_time ? end.date : '',
      'form.endTime': r.end_time ? end.time : '18:00',
      'form.hasRegistration': r.has_registration === true,
      'form.ddlDate': r.registration_deadline ? ddl.date : '',
      'form.ddlTime': r.registration_deadline ? ddl.time : '18:00',
      'form.regStartDate': r.registration_start_time ? regStart.date : '',
      'form.regStartTime': r.registration_start_time ? regStart.time : '09:00'
    })
  },

  onField(e) {
    const field = e.currentTarget.dataset.field
    const patch = {}
    patch['form.' + field] = e.detail.value
    this.setData(patch)
  },

  onHasRegistration(e) {
    this.setData({ 'form.hasRegistration': e.detail.value })
  },

  onIsRecurring(e) {
    this.setData({ 'form.isRecurring': e.detail.value })
  },

  async onSave() {
    const f = this.data.form
    if (this.data.type === 'task') {
      await this.saveTask(f)
      return
    }
    await this.saveActivity(f)
  },

  async saveActivity(f) {
    if (!f.name || !f.name.trim()) {
      wx.showToast({ title: '请填写活动名称', icon: 'none' })
      return
    }
    if (!f.startDate) {
      wx.showToast({ title: '请选择开始日期', icon: 'none' })
      return
    }
    if (this.data.saving) return
    this.setData({ saving: true })

    try {
      const session = await auth.getSession()
      if (!session) throw new Error('请先登录')

      const event = {
        name: f.name.trim(),
        location: f.location.trim(),
        note: f.note.trim(),
        start_time: buildIso(f.startDate, f.startTime),
        end_time: f.endDate ? buildIso(f.endDate, f.endTime) : null,
        has_registration: f.hasRegistration === true,
        registration_start_time: (f.hasRegistration && f.regStartDate) ? buildIso(f.regStartDate, f.regStartTime) : null,
        registration_deadline: (f.hasRegistration && f.ddlDate) ? buildIso(f.ddlDate, f.ddlTime) : null,
        event_type: 'activity',
        source_type: this.data.imageTempPath ? 'image' : 'text',
        raw_text: this.data.rawText || '',
        image_path: this.data.imageTempPath ? '' : ''
      }

      const ins = await cloud.database.from('events').insert(event).select()
      if (ins.error) throw ins.error
      const created = ins.data && ins.data[0]
      if (!created) throw new Error('保存失败')

      const reminders = computeReminders(created)
      if (reminders.length > 0) {
        const rows = reminders.map(function (r) {
          return { event_id: created.id, type: r.type, trigger_at: r.triggerAt }
        })
        await cloud.database.from('reminders').insert(rows)
      }

      this.requestSubscribe(created)
      this.collectOpenid(session.user.id)

      wx.showToast({ title: '已排入日程', icon: 'success' })
      setTimeout(function () { wx.navigateBack() }, 800)
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '保存失败', icon: 'none' })
      this.setData({ saving: false })
    }
  },

  async saveTask(f) {
    if (!f.name || !f.name.trim()) {
      wx.showToast({ title: '请填写任务名称', icon: 'none' })
      return
    }
    // 截止时间、提醒时间均为可选：留空不强制填写
    if (this.data.saving) return
    this.setData({ saving: true })

    try {
      const session = await auth.getSession()
      if (!session) throw new Error('请先登录')

      const taskDdlIso = f.taskDdlDate ? buildIso(f.taskDdlDate, f.taskDdlTime) : null
      const isRecurring = f.isRecurring === true
      // 提醒时间：仅当用户选择了「提醒日期」时才算填写（否则留空=不提醒）
      const reminderIso = f.reminderDate ? buildIso(f.reminderDate, f.reminderTime) : null
      // 周期任务：重复规则固定为 daily（每天重复）
      const recurrenceRule = isRecurring ? 'daily' : null

      // start_time 表约束 NOT NULL：任务无独立开始时间，
      // 有截止时间用截止时间，否则用提醒时间/当前时间兜底，仅满足约束、不影响展示（任务展示用 task_ddl）
      const startIso = taskDdlIso || reminderIso || new Date().toISOString()

      const event = {
        name: f.name.trim(),
        task_content: f.taskContent.trim(),
        note: f.note.trim(),
        start_time: startIso,
        task_ddl: taskDdlIso,
        is_recurring: isRecurring,
        recurrence_rule: recurrenceRule,
        reminder_time: reminderIso,
        event_type: 'task',
        source_type: 'text',
        raw_text: this.data.rawText || ''
      }

      const ins = await cloud.database.from('events').insert(event).select()
      if (ins.error) throw ins.error
      const created = ins.data && ins.data[0]
      if (!created) throw new Error('保存失败')

      const reminders = computeReminders(created)
      if (reminders.length > 0) {
        const rows = reminders.map(function (r) {
          return { event_id: created.id, type: r.type, trigger_at: r.triggerAt }
        })
        await cloud.database.from('reminders').insert(rows)
      }

      this.requestSubscribe(created)
      this.collectOpenid(session.user.id)

      wx.showToast({ title: '已添加任务', icon: 'success' })
      setTimeout(function () { wx.navigateBack() }, 800)
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '保存失败', icon: 'none' })
      this.setData({ saving: false })
    }
  },

  requestSubscribe(event) {
    const t = config.SUBSCRIPTION_TEMPLATES || {}
    const ids = []
    if (event.event_type === 'task') {
      if (t.task_ddl) ids.push(t.task_ddl)
    } else {
      if (event.has_registration && event.registration_start_time && t.registration_start) ids.push(t.registration_start)
      if (event.has_registration && t.registration_ddl) ids.push(t.registration_ddl)
      if (t.before_3d) ids.push(t.before_3d)
      if (t.before_1d) ids.push(t.before_1d)
      if (t.day_2h) ids.push(t.day_2h)
    }
    if (ids.length === 0) return
    wx.requestSubscribeMessage({
      tmplIds: ids,
      success() {},
      fail() {}
    })
  },

  async collectOpenid(uid) {
    if (!config.ENGINE_BASE_URL) return
    try {
      const code = await new Promise(function (resolve, reject) {
        wx.login({ success: function (r) { resolve(r.code) }, fail: reject })
      })
      if (!code) return
      await new Promise(function (resolve) {
        wx.request({
          url: config.ENGINE_BASE_URL.replace(/\/$/, '') + '/api/wx/openid',
          method: 'POST',
          data: { uid: uid, code: code },
          success(res) {
            const openid = res.data && res.data.openid
            if (openid) {
              cloud.database.from('user_settings').upsert({ wechat_openid: openid })
            }
            resolve()
          },
          fail() { resolve() }
        })
      })
    } catch (e) {
      // openid 收集失败不影响主流程
    }
  }
})
