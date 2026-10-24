// 事件（活动/任务）的公共数据操作，供 index 列表页与 detail 详情页复用，避免删除逻辑重复。
const { cloud } = require('./cloud')

// 删除一个事件及其所有提醒。先删提醒，再删事件本身（用数字 id 匹配 BIGINT 主键）。
// 返回 { error } 或 { ok: true }。
async function deleteEvent(id) {
  const numId = Number(String(id).replace(/\D/g, ''))
  if (!numId) return { error: new Error('缺少活动 ID') }
  try {
    await cloud.database.from('reminders').delete().eq('event_id', numId)
    const { error } = await cloud.database.from('events').delete().eq('id', numId).select()
    if (error) return { error }
    return { ok: true }
  } catch (e) {
    return { error: e }
  }
}

module.exports = { deleteEvent }
