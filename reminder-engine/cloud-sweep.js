// 云端自动调度入口（方案 B）：
// 直连 Supabase 数据库 → 查到期未发送提醒 → 复用 dispatch.js 发信 → 标记 sent → daily 续期。
// 替代本机 WorkBuddy 调度器，部署到 Railway/Render 等云端托管后，由 GitHub Actions 定时触发本文件。
//
// 与现有 server.js 的关系：
//   server.js 仍保留「接收 JSON 数组发信」的被动能力（/sweep 接口）；
//   本文件新增「主动查库 + 发信」的调度能力，是云端化的核心。
//
// 运行：node cloud-sweep.js
// 依赖环境变量（部署平台配置，勿硬编码）：
//   SUPABASE_URL              https://<ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY 服务端 key（secret，绕过 RLS 查库）
//   EMAIL_* 等发信配置         见 config.js（从 .env 读取）
const { dispatchOne } = require('./lib/dispatch')
const monitor = require('./lib/monitor')

const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

function pad(n) { return n < 10 ? '0' + n : '' + n }

async function supabaseFetch(path, options) {
  const res = await fetch(SUPABASE_URL + path, Object.assign({
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      'Content-Type': 'application/json'
    }
  }, options || {}))
  if (!res.ok) {
    const text = await res.text().catch(function () { return '' })
    throw new Error('Supabase API ' + res.status + ': ' + text.slice(0, 300))
  }
  return res
}

async function runCloudSweep() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    const msg = '缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 环境变量'
    monitor.log('error', { kind: 'config_missing', message: msg })
    return { ok: false, error: msg }
  }

  try {
    // 1. 查到期未发送的提醒（关联事件 + 用户邮箱）
    //    PostgREST 内嵌关联：reminders -> events，并单独取 user_settings.email
    const now = new Date().toISOString()
    const q = await supabaseFetch(
      '/rest/v1/reminders?select=*,events(name,event_type,location,note,start_time,task_content,task_ddl,registration_start_time,registration_deadline,recurrence_rule,reminder_time)&status=eq.pending&trigger_at=lte.' + now
    )
    const rows = await q.json()

    if (!Array.isArray(rows) || rows.length === 0) {
      await monitor.afterSweep([])
      return { ok: true, processed: 0, results: [] }
    }

    const results = []

    for (const r of rows) {
      const ev = r.events || {}

      // 取该 owner 的邮箱
      let email = null
      try {
        const uq = await supabaseFetch('/rest/v1/user_settings?select=email&owner_id=eq.' + r.owner_id)
        const us = await uq.json()
        email = (us && us[0] && us[0].email) || null
      } catch (e) {
        monitor.log('warn', { kind: 'user_settings_fail', reminder_id: r.id, message: e.message })
      }

      // 2. 组装成 dispatchOne 需要的字段，复用现有发信逻辑（邮件/微信/短信三渠道）
      const payload = {
        reminder_id: r.id,
        type: r.type,
        event_name: ev.name || '',
        start_time: ev.start_time || null,
        location: ev.location || '',
        note: ev.note || '',
        event_type: ev.event_type || '',
        task_content: ev.task_content || null,
        task_ddl: ev.task_ddl || null,
        registration_start_time: ev.registration_start_time || null,
        registration_deadline: ev.registration_deadline || null,
        email: email,
        wechat_openid: null // 微信订阅消息暂未接入
      }

      const out = await dispatchOne(payload)
      results.push(out)

      // 3. 至少一个渠道成功 → 标记 sent
      const channels = out.channels || []
      const anyOk = channels.some(function (c) { return c.status === 'ok' || c.status === 'sent' })

      if (anyOk) {
        try {
          await supabaseFetch('/rest/v1/reminders?id=eq.' + r.id, {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'sent', sent_at: new Date().toISOString() })
          })

          // 4. task_daily 续期：插入「下一天」同一时分的新提醒
          if (r.type === 'task_daily') {
            const rt = ev.reminder_time
            let h = 9, m = 0
            if (rt) {
              const d = new Date(rt)
              if (!isNaN(d.getTime())) { h = d.getHours(); m = d.getMinutes() }
            }
            const next = new Date()
            next.setHours(h, m, 0, 0)
            next.setDate(next.getDate() + 1)

            await supabaseFetch('/rest/v1/reminders', {
              method: 'POST',
              headers: { Prefer: 'return=minimal' },
              body: JSON.stringify({
                event_id: r.event_id,
                owner_id: r.owner_id,
                type: 'task_daily',
                trigger_at: next.toISOString(),
                status: 'pending'
              })
            })
          }
        } catch (e) {
          monitor.log('error', { kind: 'mark_sent_fail', reminder_id: r.id, message: e.message })
        }
      }
    }

    // 5. 采集指标 + 评估告警
    await monitor.afterSweep(results)
    return { ok: true, processed: rows.length, results: results }
  } catch (e) {
    monitor.log('error', { kind: 'fatal', message: e && e.message ? e.message : String(e) })
    return { ok: false, error: e && e.message ? e.message : String(e) }
  }
}

// 直接以 node cloud-sweep.js 运行时，执行一次并退出
if (require.main === module) {
  runCloudSweep().then(function (res) {
    console.log(JSON.stringify(res))
    process.exit(res.ok ? 0 : 1)
  }).catch(function (e) {
    monitor.log('error', { kind: 'fatal', message: e && e.message ? e.message : String(e) })
    console.error(e && e.message ? e.message : e)
    process.exit(1)
  })
}

module.exports = { runCloudSweep }
