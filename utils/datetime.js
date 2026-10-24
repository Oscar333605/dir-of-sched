// 时间解析与构建的统一工具。集中处理时区、格式，保证「LLM 输出 → 表单 → 数据库」链路时间一致。
// 核心原则：所有时间都按「用户本地时区（东八区 UTC+8）」解释与展示，存储统一用带时区的 ISO8601（toISOString 即 UTC）。

function pad(n) { return n < 10 ? '0' + n : '' + n }

// 目标时区偏移（分钟）。默认东八区；如用户在其他时区可在此调整。
const TZ_OFFSET_MINUTES = 8 * 60

// 把任意输入解析成一个确定的本地时间对象（Date）。
// 兼容：带时区偏移的 ISO8601、无时区的本地串、纯日期、时间戳等。
function parseToDate(value) {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value
  const s = String(value).trim()
  if (!s) return null

  // 1) 带时区偏移的 ISO8601（如 2026-10-28T18:00:00+08:00 或 ...Z）→ 直接解析，绝对时刻正确
  if (/[+-]\d{2}:?\d{2}$/.test(s) || /Z$/i.test(s)) {
    const d = new Date(s)
    return isNaN(d.getTime()) ? null : d
  }

  // 2) 无时区的「YYYY-MM-DD HH:mm」或「YYYY-MM-DDTHH:mm(:ss)」→ 按本地时区解释
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?/)
  if (m) {
    const local = new Date(
      parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10),
      parseInt(m[4], 10), parseInt(m[5], 10), parseInt(m[6] || '0', 10), 0
    )
    return isNaN(local.getTime()) ? null : local
  }

  // 3) 纯日期 YYYY-MM-DD → 当天 00:00
  const dm = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (dm) {
    const local = new Date(parseInt(dm[1], 10), parseInt(dm[2], 10) - 1, parseInt(dm[3], 10), 0, 0, 0, 0)
    return isNaN(local.getTime()) ? null : local
  }

  // 4) 兜底：交给 Date 解析
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

// 日期部分 YYYY-MM-DD（按本地时区）
function toDateStr(d) {
  if (!d) return ''
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

// 时间部分 HH:mm（按本地时区）
function toTimeStr(d) {
  if (!d) return ''
  return pad(d.getHours()) + ':' + pad(d.getMinutes())
}

// 把一个 ISO 串拆成 { date, time }，供表单 picker 使用。
// 关键：始终用 parseToDate 统一解析，避免 new Date(iso) 在「无时区串」上被误当 UTC。
function splitIso(iso) {
  const d = parseToDate(iso)
  if (!d) {
    const now = new Date()
    return { date: toDateStr(now), time: '09:00' }
  }
  return { date: toDateStr(d), time: toTimeStr(d) }
}

// 由表单的 date + time 构建带时区的 ISO8601（存储用）。
// 关键：用本地时区的各分量构造 Date，再 toISOString() 输出 UTC，绝对时刻正确、不偏移。
function buildIso(date, time) {
  const t = time || '09:00'
  const parts = String(date || '').split('-')
  if (parts.length !== 3) return null
  const tp = t.split(':')
  const local = new Date(
    parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10),
    parseInt(tp[0], 10), parseInt(tp[1] || '0', 10), 0, 0
  )
  if (isNaN(local.getTime())) return null
  return local.toISOString()
}

// 规范化 LLM 返回的时间串：确保带时区偏移（默认 +08:00）。
// 用于把「可能无时区/UTC」的模型输出，钉死在用户本地时区，消除 8 小时偏差。
function normalizeIso(value) {
  if (!value) return ''
  const d = parseToDate(value)
  if (!d) return ''
  return d.toISOString()
}

module.exports = { parseToDate, toDateStr, toTimeStr, splitIso, buildIso, normalizeIso, TZ_OFFSET_MINUTES }
