/** 判断层：把"值得找你"的候选，按**三问**筛成"能开口的话"（spec/03 §6 ⑨ · spec/55 P3）。
 *
 *  ## 三问
 *   变了什么（事实）· 对你意味着什么（判断）· 现在能做什么（动作）
 *  缺第 3 问 = **通知**；缺第 2 问 = **播报**；三问齐 = **建议**。
 *
 *  ## 为什么是纯函数
 *  判断层要能被单测、被回放、被计数（收敛度 = 出声数 / 候选数）。
 *  它不碰存储、不调模型、不发消息 —— 模型只负责在最后把这三句写成一段人话（D2）。
 *
 *  ## 动作不是"再点一下"
 *  这里的动作只做**站内导航**（打开哪个对象、用哪个动词），不产生对外副作用；
 *  真要动外部系统属于 F25「确认后执行」，本次不碰。所以即使判断错了，代价也只是一次点击。
 */

/** 每类候选能给的"能做什么"：一个动词 + 一个去向。 */
const ACTIONS = {
 '守承诺': candidate => candidate.overdue
  ? {verb: '看看怎么收尾', target: candidate.subjectId}
  : {verb: '打开这件事', target: candidate.subjectId},
 '盯依赖': candidate => ({verb: '打开可以继续的那件', target: candidate.subjectId}),
 '看落实': candidate => ({verb: candidate.what?.startsWith('在等') ? '把等待改成结论' : '写一条着落', target: candidate.subjectId}),
 '做简报': candidate => ({verb: '看看新到的材料', target: candidate.subjectId}),
 '复核旧判断': candidate => ({verb: '回看这条判断', target: candidate.subjectId}),
};

/** 一个候选能不能开口：三问缺一不可，缺哪问要说出来。 */
export function threeAnswers(candidate) {
 const changed = typeof candidate?.what === 'string' && candidate.what.trim() ? candidate.what.trim() : null;
 const means = typeof candidate?.why === 'string' && candidate.why.trim() ? candidate.why.trim() : null;
 const actionRule = ACTIONS[candidate?.rule] ?? null;
 const action = actionRule && candidate?.subjectId ? actionRule(candidate) : null;
 const missing = [];
 if (!changed) missing.push('变了什么');
 if (!means) missing.push('意味着什么');
 if (!action) missing.push('能做什么');
 if (missing.length) return {ok: false, missing, item: null};
 return {ok: true, missing: [], item: {
  id: String(candidate.subjectId),
  rule: candidate.rule,
  title: String(candidate.title ?? candidate.subjectId),
  changed, means,
  verb: action.verb, target: action.target,
  level: Number.isInteger(candidate.level) ? candidate.level : 1,
 }};
}

const ANCHOR_HOURS = {morning: 9.5, evening: 21};

/** 现在是不是开口点（本地时间）。窗口 = 到点后 30 分钟内，避免一次抖动就错过一整次。
 *  真正的定时由宿主 timer 负责；这里是**判断"这次醒来的身份"**，两者不混。 */
export function anchorOf(now = new Date(), {windowMinutes = 30} = {}) {
 for (const [anchor, hour] of Object.entries(ANCHOR_HOURS)) {
  const target = new Date(now);
  target.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0);
  const minutes = (now.getTime() - target.getTime()) / 60000;
  if (minutes >= 0 && minutes <= windowMinutes) return anchor;
 }
 return null;
}

/** 一次开口的选品：三问过滤 → 按级别与时间紧迫度排序 → 封顶。
 *  @param cap 一次最多说几条（用户拍板 D5：5 条）。 */
export function selectForAnchor(candidates, {anchor = null, cap = 5, now = new Date()} = {}) {
 const items = [], skipped = [];
 for (const candidate of candidates ?? []) {
  const judged = threeAnswers(candidate);
  if (!judged.ok) {
   // 缺哪一问要留痕 —— 这是"为什么没说"里最有信息量的一种。
   skipped.push({id: candidate?.subjectId ?? null, rule: candidate?.rule ?? null,
    why: '缺「' + judged.missing.join('」「') + '」'});
   continue;
  }
  // 同一件事只出一次：靠 subjectId 去重（同一批里可能被两条规则同时命中）。
  if (items.some(item => item.id === judged.item.id)) continue;
  items.push(judged.item);
 }
 const ranked = items.sort((a, b) => b.level - a.level);
 const kept = ranked.slice(0, Math.max(0, Math.floor(cap)));
 const overflow = ranked.slice(kept.length).map(item => ({id: item.id, rule: item.rule, why: '排不进这次的前 ' + cap + ' 条'}));
 // 同一时段够格的事合成一条：这是"合并，不零散"的落点（03 §6 ④）。
 return {anchor, at: now.toISOString(), items: kept, skipped: [...skipped, ...overflow],
  summary: kept.length ? kept.length + ' 条' : '没有值得现在说的'};
}
