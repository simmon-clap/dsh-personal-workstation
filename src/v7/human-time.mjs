/** 时间说人话（宪章七「可读」）。
 *
 *  起因（用户 2026-10-14）：日历里点开一个安排，时间显示成 `2026-10-12T10:30:00+08:00`。
 *  他一眼就说"什么来源呀、编码呀，这些都不需要显示吧"——ISO 串对用户就是编码。
 *
 *  规则（同一件事全站只用这一个实现 —— VI §6「同一控件唯一实现」）：
 *    · 同一年：`10月12日 周一 10:30`
 *    · 跨年：`2027年1月3日 周日 09:00`
 *    · 全天（没有具体时刻）：只说日期
 *    · 只有日期没有时刻：`10月12日 周一`
 *    · 解析不出来：原样返回（不编造，也不显示 Invalid Date —— 宪章六「诚实」）
 */
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const parse = value => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  // `2026-10-12 10:30` 这类空格分隔的写法，Safari 解析不了，统一成 T。
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text) ? text.replace(' ', 'T') : text;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
};

const pad = number => String(number).padStart(2, '0');

/** 有没有带时刻（`2026-10-12` 只有日期，`...T10:30` 有时刻）。 */
export function hasTimeOfDay(value) {
  return /T\d{2}:\d{2}|^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(String(value ?? ''));
}

/** 一个时间点 → 人话。 */
export function whenText(value, {now = new Date()} = {}) {
  const date = parse(value);
  if (!date) return value === undefined || value === null || value === '' ? '未设置' : String(value);
  const sameYear = date.getFullYear() === now.getFullYear();
  const day = sameYear
    ? `${date.getMonth() + 1}月${date.getDate()}日`
    : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  const head = `${day} ${WEEK[date.getDay()]}`;
  return hasTimeOfDay(value) ? `${head} ${pad(date.getHours())}:${pad(date.getMinutes())}` : head;
}

/** 只有日期的场合（日历格、截止日）。 */
export function dayText(value, {now = new Date()} = {}) {
  const date = parse(value);
  if (!date) return value === undefined || value === null || value === '' ? '未设置' : String(value);
  return date.getFullYear() === now.getFullYear()
    ? `${date.getMonth() + 1}月${date.getDate()}日`
    : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 一个时间段 → 人话；同一天不重复写日期。 */
export function spanText(startValue, endValue, options = {}) {
  const start = parse(startValue);
  const end = parse(endValue);
  if (!start) return whenText(startValue, options);
  if (!end) return whenText(startValue, options);
  const sameDay = start.toDateString() === end.toDateString();
  return sameDay ? `${whenText(startValue, options)}–${pad(end.getHours())}:${pad(end.getMinutes())}` : `${whenText(startValue, options)} → ${whenText(endValue, options)}`;
}
