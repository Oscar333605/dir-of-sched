// 时间工具单元测试。运行：node utils/datetime.test.js
const dt = require('./datetime')
let pass = 0, fail = 0
function eq(actual, expected, name) {
  if (actual === expected) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + '  expected=' + expected + ' got=' + actual) }
}

console.log('== buildIso 时区正确性（本地 18:00 应转为 UTC 10:00，即 +08:00）==')
eq(dt.buildIso('2026-10-28', '18:00'), '2026-10-28T10:00:00.000Z', 'buildIso 2026-10-28 18:00 -> 10:00Z')

console.log('== splitIso 无时区串（应按本地解释，不是 UTC）==')
let s = dt.splitIso('2026-10-28T18:00:00')
eq(s.date, '2026-10-28', 'splitIso 无时区串 date')
eq(s.time, '18:00', 'splitIso 无时区串 time（不能变成 02:00 或 26:00）')

console.log('== splitIso 带时区偏移串（+08:00 应保持本地 18:00）==')
s = dt.splitIso('2026-10-28T18:00:00+08:00')
eq(s.date, '2026-10-28', 'splitIso +08:00 date')
eq(s.time, '18:00', 'splitIso +08:00 time')

console.log('== splitIso UTC 串（Z 结尾，东八区应为 18:00）==')
s = dt.splitIso('2026-10-28T10:00:00Z')
eq(s.time, '18:00', 'splitIso 10:00Z -> 本地 18:00')

console.log('== normalizeIso 统一补时区 ==')
eq(dt.normalizeIso('2026-10-28T18:00:00'), '2026-10-28T10:00:00.000Z', 'normalizeIso 无时区 -> UTC 绝对时刻')
eq(dt.normalizeIso('2026-10-28T18:00:00+08:00'), '2026-10-28T10:00:00.000Z', 'normalizeIso +08:00 -> UTC')

console.log('== buildIso/splitIso 往返一致性 ==')
const iso = dt.buildIso('2026-10-28', '18:00')
const back = dt.splitIso(iso)
eq(back.date, '2026-10-28', '往返 date 一致')
eq(back.time, '18:00', '往返 time 一致（18:00 不变）')

console.log('\n结果：' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail > 0 ? 1 : 0)
