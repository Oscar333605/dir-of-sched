// 提醒调度执行器（单次执行）。
// 输入：一批待发送提醒（JSON 数组），对每个提醒并发走 邮件 + 微信 + 短信 三个渠道，输出各渠道结果。
//
// 用法：
//   node sweep.js --reminders='[{"reminder_id":1,"type":"before_3d","event_name":"...","start_time":"...","location":"...","registration_deadline":"...","email":"...","wechat_openid":"...","phone":null}]'
// 或从 stdin 读取：  echo '[ ... ]' | node sweep.js
//
// 输出：JSON 数组 [{ reminder_id, channels: [{channel,status,reason?}] }]
const { dispatchOne } = require('./lib/dispatch')

async function main() {
  let json = ''
  const arg = process.argv.find(function (a) { return a.indexOf('--reminders=') === 0 })
  if (arg) {
    json = arg.slice('--reminders='.length)
  } else {
    for await (const chunk of process.stdin) json += chunk
  }
  let reminders = []
  try {
    reminders = JSON.parse(json || '[]')
  } catch (e) {
    console.error('invalid reminders json: ' + e.message)
    process.exit(1)
  }
  const out = []
  for (const r of reminders) out.push(await dispatchOne(r))
  console.log(JSON.stringify(out))
}

main().catch(function (e) {
  console.error(e && e.message ? e.message : e)
  process.exit(1)
})
