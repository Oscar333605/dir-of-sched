// 单条微信订阅消息发送 CLI（供自动化调度器逐条调用）。
// 用法：
//   node wechat-send.js --openid=oXXX --type=before_3d --name='活动' --start='2026-10-25T14:00:00+08:00' --location='地点' --deadline=''
const { buildMessages } = require('./lib/message')
const wechat = require('./channels/wechat')

async function main() {
  const args = {}
  process.argv.slice(2).forEach(function (a) {
    const m = a.match(/^--([^=]+)=(.*)$/)
    if (m) args[m[1]] = m[2]
  })
  const r = {
    type: args.type,
    event_name: args.name,
    start_time: args.start,
    location: args.location,
    registration_deadline: args.deadline
  }
  const msg = buildMessages(r.type, r)
  const result = await wechat.sendSubscription(args.openid, r.type, msg.wechatData)
  console.log(JSON.stringify(result))
}

main().catch(function (e) {
  console.error(e && e.message ? e.message : e)
  process.exit(1)
})
