const { cloud } = require('./cloud')
const { normalizeIso } = require('./datetime')

// 生成「当前日期上下文」，注入到 prompt 中，让模型在推断相对时间
// （如「明天」「下周三」「本周五」）时有准确的参照基准，避免日期推断错误。
function nowContext() {
  const d = new Date()
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  return '今天是 ' + d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日，星期' + week +
    '（UTC+8 时区）。推断相对时间请以此为基准。'
}

const SYSTEM_PROMPT = '你是日程信息抽取助手。从用户提供的活动描述中抽取结构化信息。只输出一个 JSON 对象，不要输出任何解释或多余文字。' +
  '字段含义：name=活动名称(字符串)；start_time=活动开始时间(ISO8601 字符串，如 2026-10-25T14:00:00+08:00)；' +
  'end_time=活动结束时间(ISO8601 字符串，没有则为 null)；location=活动地点(字符串，没有则为空字符串)；' +
  'note=备注/特殊说明(字符串，如着装要求、携带物品、注意事项等，没有则为空字符串)；' +
  'has_registration=是否包含报名环节(布尔值)；registration_start_time=报名开始时间(ISO8601 字符串，没有则为 null)；' +
  'registration_deadline=报名截止时间(ISO8601 字符串，没有则为 null)。' +
  '地点抽取规则：location 必须完整、准确地抽取活动举办地点，优先保留原文中的具体地址、楼栋、房间号、线上会议链接/会议号等；' +
  '若原文为线上活动，location 填线上平台及链接/会议号；确实没有地点信息时才返回空字符串，不要用活动名称或主办方代替地点。' +
  '备注抽取规则：note 抽取原文中提到的着装要求、携带物品、特殊注意事项等说明性文字，没有则为空字符串。' +
  '时间解析规则（务必严格遵守）：' +
  '1) 必须准确识别年份、月份、日期、时、分；原文写「下周三」「明天」「后天」等相对时间时，要结合上下文推断出具体日期，不要漏掉或写错日期；' +
  '2) 原文明确写「截止/截止时间/DDL/Deadline」时，该时间应归入 registration_deadline（任务则归入 task_ddl），不要误填到 start_time；' +
  '3) 使用 24 小时制，区分上午/下午（如下午3点=15:00）；' +
  '4) 只输出明确存在的时间，无法确定的用 null，不要用当前日期凑数。' +
  '如果原文只有日期没有具体时间，开始时间默认为当天 09:00:00。' +
  '无法确定的字段用 null 或空字符串，不要编造。'

const TASK_SYSTEM_PROMPT = '你是任务信息抽取助手。从用户提供的任务描述中抽取结构化信息。只输出一个 JSON 对象，不要输出任何解释或多余文字。' +
  '字段含义：name=任务名称(字符串)；task_content=工作内容/任务说明(字符串)；task_ddl=任务截止时间(ISO8601 字符串，如 2026-10-28T18:00:00+08:00)；' +
  'note=备注(字符串，没有则为空字符串)。' +
  '时间解析规则（务必严格遵守）：' +
  '1) 必须准确识别年份、月份、日期、时、分；原文写「下周三」「明天」「后天」「本周五」等相对时间时，要结合上下文推断出具体日期；' +
  '2) 原文中的「截止/截止时间/DDL/Deadline/之前交/需在…前完成」等表述对应的就是 task_ddl，务必准确提取，不要把截止时间当作开始时间；' +
  '3) 使用 24 小时制，区分上午/下午（如下午3点=15:00）；' +
  '4) 只输出明确存在的时间，无法确定的 task_ddl 用 null，不要用当前日期凑数。' +
  '无法确定的字段用 null 或空字符串，不要编造。'

// 模型列表缓存：避免每次解析都重复拉取模型列表（额外网络请求）
let _modelsCache = null
let _modelsPromise = null

async function getModels() {
  if (_modelsCache && _modelsCache.length > 0) return _modelsCache
  if (_modelsPromise) return _modelsPromise
  _modelsPromise = cloud.llm.models.list().then(function (models) {
    _modelsCache = models || []
    _modelsPromise = null
    return _modelsCache
  }).catch(function (e) {
    _modelsPromise = null
    throw e
  })
  return _modelsPromise
}

// 调用云端大模型做一次性抽取，返回解析出的 JSON 字符串。
// 注意：该云服务 LLM 接口仅支持流式（stream:true），非流式会被 SDK 拒绝（request_stream_required）。
// 这里用流式收集完整结果；提速主要靠复用 getModels 的模型列表缓存。
async function callLLM(messages) {
  const models = await getModels()
  if (!models || models.length === 0) {
    throw new Error('暂无可用模型')
  }
  const model = models.find(function (m) { return m.disabled !== true }) || models[0]

  let text = ''
  for await (const chunk of cloud.llm.chat.completions.create({
    model: model.id,
    messages: messages,
    stream: true,
    temperature: 0,
    response_format: { type: 'json_object' }
  })) {
    const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta
    if (delta && delta.content) text += delta.content
  }
  return text
}

function normalizeField(value) {
  return value === null || value === undefined ? '' : String(value)
}

// 解析纯文字描述
async function parseText(rawText) {
  const text = await callLLM([
    { role: 'system', content: SYSTEM_PROMPT + nowContext() },
    { role: 'user', content: rawText }
  ])
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    // 模型偶尔会在 JSON 外层包裹说明，做一次宽松提取。
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('解析失败，请检查内容后重试')
    parsed = JSON.parse(match[0])
  }
  return {
    name: normalizeField(parsed.name),
    start_time: normalizeIso(parsed.start_time),
    end_time: normalizeIso(parsed.end_time),
    location: normalizeField(parsed.location),
    note: normalizeField(parsed.note),
    has_registration: parsed.has_registration === true,
    registration_start_time: normalizeIso(parsed.registration_start_time),
    registration_deadline: normalizeIso(parsed.registration_deadline)
  }
}

// 解析任务描述（使用任务专用 prompt，准确识别截止时间）
async function parseTask(rawText) {
  const text = await callLLM([
    { role: 'system', content: TASK_SYSTEM_PROMPT + nowContext() },
    { role: 'user', content: rawText }
  ])
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('解析失败，请检查内容后重试')
    parsed = JSON.parse(match[0])
  }
  return {
    name: normalizeField(parsed.name),
    task_content: normalizeField(parsed.task_content),
    task_ddl: normalizeIso(parsed.task_ddl),
    note: normalizeField(parsed.note)
  }
}

// 解析截图：优先走多模态；模型不支持图片时抛错，由调用方降级。
async function parseImage(imageUrl) {
  const models = await getModels()
  const model = models.find(function (m) { return m.disabled !== true }) || models[0]
  if (!model || model.supportsImages !== true) {
    throw new Error('当前模型不支持图片识别，请改为粘贴文字内容')
  }
  const text = await callLLM([
    { role: 'system', content: SYSTEM_PROMPT + nowContext() },
    {
      role: 'user',
      content: [
        { type: 'text', text: '请识别这张活动截图，抽取其中的活动信息。' },
        { type: 'image_url', image_url: { url: imageUrl } }
      ]
    }
  ])
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('图片识别失败，请改为粘贴文字内容')
    parsed = JSON.parse(match[0])
  }
  return {
    name: normalizeField(parsed.name),
    start_time: normalizeIso(parsed.start_time),
    end_time: normalizeIso(parsed.end_time),
    location: normalizeField(parsed.location),
    note: normalizeField(parsed.note),
    has_registration: parsed.has_registration === true,
    registration_start_time: normalizeIso(parsed.registration_start_time),
    registration_deadline: normalizeIso(parsed.registration_deadline)
  }
}

// 判断文本是否为公众号文章链接（mp.weixin.qq.com 等）。
function isArticleLink(text) {
  return /https?:\/\/(mp\.weixin\.qq\.com|weixin\.qq\.com)/.test(text || '')
}

module.exports = { parseText, parseTask, parseImage, isArticleLink, callLLM, nowContext }
