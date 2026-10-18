/**
 * 主动做事：四类判定（F19 守承诺 / F20 盯依赖 / F21 做简报 / F22 复核旧判断）+ 留痕（F24）。
 *
 * 设计约束（[spec/03 §6](功能与交互设计) ①⑦、交互律 11/12）：
 *  - **做事不需要理由，出声需要**：本模块只做判定与留痕，**不发送任何消息**。出声属批次 8。
 *  - **留痕必须如实**：每条都要能回答"看到什么"，以及"为什么没打扰你"。
 *  - **门槛默认最小**：只有"错过就没了的事"才算值得找你；其余一律写下沉默理由。
 *  - **不产出没有来源的判断**：简报必须带真实来源与时间（取对象自己的记录时间，不编）。
 *  - **真定时需要常驻节点**：本模块只支持手动触发，**不得对外声称"已在定时运行"**。
 */
import {FAILURE_ALERT_THRESHOLD} from './heartbeat-store.mjs';

/** 一天 = 86400000 毫秒；日期按"天"比较（dueDate 这类字段是 YYYY-MM-DD）。 */
const DAY = 86400000;
const dayNumber = value => {
 const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
 if (!match) return null;
 return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY;
};
const daysUntil = (value, now) => {
 const day = dayNumber(value);
 if (day === null) return null;
 return day - Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / DAY);
};
const openTask = task => !['done', 'cancelled'].includes(task.data?.status);
/** 这次才跨过阈值吗？（上次跑时还没到、这次到了）——"有新的可核对事实"就靠它，避免把老状态当新闻。 */
const crossedInto = (dateValue, threshold, now, since) => {
 const nowDays = daysUntil(dateValue, now);
 if (nowDays === null || nowDays > threshold) return false;
 if (!since) return true;
 const thenDays = daysUntil(dateValue, new Date(since));
 return thenDays === null || thenDays > threshold;
};
const WAITING_FOR_OTHERS = /等|对方|客户|回复|确认/;

/** 四类判定。每条返回 {looked, candidates, silenced}：
 *  looked = 这次看了什么；candidates = 值得找你（附理由）；silenced = 不打扰（附理由）。 */
export const HEARTBEAT_RULES = [
 {
  id: 'commitments', label: '守承诺',
  run: ({store, ctx, now, since}) => {
   const tasks = store.list(ctx, {kind: 'task', limit: 1000});
   const events = store.list(ctx, {kind: 'event', limit: 1000});
   const candidates = [], silenced = [];
   for (const task of tasks) {
    if (!openTask(task)) continue;
    const title = task.data?.title ?? task.id;
    const due = daysUntil(task.data?.dueDate, now);
    if (due === null) continue;
    // commitment：与你承诺过的事（有明确交付日期）直接相关；fresh：这次才跨过"临期/到期"的线。
    const item = {rule: '守承诺', subjectId: task.id, title, what: '交付日期 ' + task.data.dueDate,
     days: due, commitment: true, overdue: due <= 0, fresh: crossedInto(task.data.dueDate, 1, now, since)};
    if (due <= 0) candidates.push({...item, why: due === 0 ? '今天到期' : '已经过期 ' + Math.abs(due) + ' 天', level: 2});
    else if (due <= 2) candidates.push({...item, why: due === 1 ? '明天到期' : '后天到期', level: 2});
    else if (due <= 7) silenced.push({...item, why: '还有 ' + due + ' 天，现在说太早'});
    else silenced.push({...item, why: '还有 ' + due + ' 天'});
   }
   for (const task of tasks) {
    if (!openTask(task) || task.data?.status !== 'waiting') continue;
    const reason = String(task.data?.blockedReason ?? '').trim();
    if (!reason || !WAITING_FOR_OTHERS.test(reason)) continue;
    const title = task.data?.title ?? task.id;
    const due = daysUntil(task.data?.dueDate, now);
    const item = {rule: '守承诺', subjectId: task.id, title, what: '等着：' + reason,
     days: due, commitment: true, overdue: due !== null && due <= 0, fresh: crossedInto(task.data?.dueDate, 3, now, since)};
    if (due !== null && due <= 3) candidates.push({...item, why: '别人在等你，交付日期 ' + task.data.dueDate, level: 2});
    else silenced.push({...item, why: '在等对方，但还没到要紧的时候'});
   }
   for (const event of events) {
    const start = daysUntil(event.data?.startDate, now);
    if (start === null || start < 0 || start > 1) continue;
    candidates.push({rule: '守承诺', subjectId: event.id, title: event.data?.title ?? event.id,
     what: '日程 ' + event.data.startDate, why: start === 0 ? '就是今天' : '明天', level: 1,
     days: start, commitment: true, overdue: false, fresh: crossedInto(event.data.startDate, 1, now, since)});
   }
   return {looked: [{what: '未完成的任务', count: tasks.filter(openTask).length}, {what: '日程', count: events.length}], candidates, silenced};
  },
 },
 {
  id: 'dependencies', label: '盯依赖',
  run: ({store, ctx, since}) => {
   const tasks = store.list(ctx, {kind: 'task', limit: 1000});
   const candidates = [], silenced = [];
   let withDependencies = 0;
   for (const task of tasks) {
    if (!openTask(task)) continue;
    const dependsOn = Array.isArray(task.data?.dependsOn) ? task.data.dependsOn : [];
    if (!dependsOn.length) continue;
    withDependencies += 1;
    const title = task.data?.title ?? task.id;
    const named = [], done = [], unresolved = [];
    for (const id of dependsOn) {
     const dependency = store.get(ctx, id);
     if (!dependency || dependency.archived) { unresolved.push(id); continue; }
     named.push(dependency.data?.title ?? id);
     (dependency.data?.status === 'done' ? done : unresolved).push(dependency.data?.title ?? id);
    }
    const item = {rule: '盯依赖', subjectId: task.id, title, what: '依赖：' + (named.join('、') || dependsOn.join('、'))};
    if (named.length && !unresolved.length) {
     // fresh：依赖是**上次跑之后**才完成的（用对象的记录时间，不猜）。
     const changedAt = dependsOn.map(id => Date.parse(store.get(ctx, id)?.at ?? '')).filter(Number.isFinite);
     const fresh = !since || changedAt.some(at => at > Date.parse(since));
     candidates.push({...item, why: '依赖已解锁（' + done.join('、') + ' 完成），你可以继续', level: 1,
      commitment: false, fresh, days: null});
    }
    else if (named.length && unresolved.length) silenced.push({...item, why: '还在等 ' + unresolved.join('、')});
    else silenced.push({...item, why: '依赖对象已不在，判断不了，不猜'});
   }
   return {looked: [{what: '有依赖的任务', count: withDependencies}], candidates, silenced};
  },
 },
 {
  id: 'briefs', label: '做简报',
  run: ({store, ctx, now, since}) => {
   const topics = store.list(ctx, {kind: 'topic', limit: 200});
   const materials = store.list(ctx, {kind: 'artifact', limit: 1000});
   const candidates = [], silenced = [];
   // "新"必须有基线：第一次跑（没有上次成功时间）就用议题自己的记录时间，
   // 绝不把"所有材料"当成新信息 —— 那会让每个议题都变成"值得找你"，等于没做判断。
   const baseline = Number.isFinite(Date.parse(since ?? '')) ? Date.parse(since) : null;
   for (const topic of topics) {
    // 只说"有新材料"，且必须能指出来源与它自己的时间 —— 没有来源就不产出。
    const fresh = materials.filter(material => {
     if (material.data?.projectId && topic.data?.projectId && material.data.projectId !== topic.data.projectId) return false;
     const at = Date.parse(material.at ?? '');
     if (!Number.isFinite(at)) return false;
     const from = baseline ?? Date.parse(topic.at ?? '');
     return Number.isFinite(from) ? at > from : false;
    });
    const title = topic.data?.title ?? topic.id;
    if (!fresh.length) { silenced.push({rule: '做简报', subjectId: topic.id, title, what: '关注中的议题', why: '没有新材料'}); continue; }
    const first = fresh[0];
    candidates.push({rule: '做简报', subjectId: topic.id, title, what: fresh.length + ' 份新材料，最近一份是「' + (first.data?.title ?? first.id) + '」',
     why: '有新信息，值得看一眼', level: 1, commitment: false, fresh: true, days: null, material: true,
     source: {id: first.id, title: first.data?.title ?? first.id, at: first.at ?? null, fetchedAt: first.data?.fetchedAt ?? null}});
   }
   if (!topics.length) silenced.push({rule: '做简报', subjectId: null, title: null, what: '关注的议题', why: '还没有标为关注的议题，没有可做简报的对象'});
   return {looked: [{what: '关注的议题', count: topics.length}, {what: '材料', count: materials.length}], candidates, silenced};
  },
 },
 {
  id: 'reviews', label: '复核旧判断',
  run: ({store, ctx, now, since}) => {
   const judgments = store.list(ctx, {kind: 'judgment', limit: 1000});
   const materials = store.list(ctx, {kind: 'artifact', limit: 1000});
   const candidates = [], silenced = [];
   for (const judgment of judgments) {
    const title = judgment.data?.title ?? judgment.id;
    const due = daysUntil(judgment.data?.reviewBy, now);
    if (due !== null && due <= 0) {
     candidates.push({rule: '复核旧判断', subjectId: judgment.id, title, what: '复核时间 ' + judgment.data.reviewBy,
      why: '到了你定的复核时间', level: 1, commitment: false, days: due,
      fresh: crossedInto(judgment.data.reviewBy, 0, now, since)});
     continue;
    }
    const newer = materials.filter(material => {
     const at = Date.parse(material.at ?? '');
     return Number.isFinite(at) && Number.isFinite(Date.parse(judgment.at ?? '')) && at > Date.parse(judgment.at);
    });
    if (judgment.data?.status === 'checking') {
     if (newer.length) candidates.push({rule: '复核旧判断', subjectId: judgment.id, title, what: '待核对，期间新增 ' + newer.length + ' 份材料',
      why: '有新材料，值得重新看', level: 1, commitment: false, fresh: true, days: null});
     else silenced.push({rule: '复核旧判断', subjectId: judgment.id, title, what: '待核对', why: '还没有新证据'});
     continue;
    }
    const age = daysUntil(judgment.data?.validFrom, now);
    if (age !== null && -age > 90) silenced.push({rule: '复核旧判断', subjectId: judgment.id, title,
     what: '什么时候成立：' + judgment.data.validFrom, why: Math.abs(age) + ' 天前的判断，还没有新证据，先不动它'});
    else silenced.push({rule: '复核旧判断', subjectId: judgment.id, title, what: '状态 ' + (judgment.data?.status ?? '未设置'), why: '还不用复核'});
   }
   return {looked: [{what: '判断', count: judgments.length}, {what: '材料', count: materials.length}], candidates, silenced};
  },
 },
];

/**
 * 手动跑一次：逐条判定，任一规则抛错都记进 errors 并继续（其余规则的结论照样留痕）。
 * @returns 一次完整的留痕记录（可直接交给 HeartbeatStore.record）
 */
export function runHeartbeat({store, ctx, now = new Date(), rules = HEARTBEAT_RULES, since = null, logger = null, speak = null, scheduled = false, intervalMinutes = 0} = {}) {
 if (!store || !ctx) throw new Error('主动做事需要存储与工作区上下文');
 const startedAt = now.toISOString();
 const looked = [], candidates = [], silenced = [], errors = [];
 for (const rule of rules) {
  try {
   const outcome = rule.run({store, ctx, now, since});
   looked.push(...(outcome.looked ?? []));
   candidates.push(...(outcome.candidates ?? []));
   silenced.push(...(outcome.silenced ?? []));
  } catch (error) {
   errors.push({rule: rule.label, message: error?.message ?? String(error)});
   logger?.(rule.label, error);
  }
 }
 const record = {
  // 「定时开没开」必须如实（2026-10-17 修）：定时真的接上之后，这里原来还写着
  // "还没有接入定时，不会自己醒" —— 用户看到会以为定时没生效，而它其实每 60 分钟就在跑。
  trigger: scheduled ? 'timer' : 'manual',
  scheduled: Boolean(scheduled),
  // 与 heartbeat-store.status 同一套话术：有定时 / 没定时，不再出现"未接入"这类第三种说法。
  scheduledNote: scheduled
   ? '定时已开启：每 ' + intervalMinutes + ' 分钟它自己会醒一次（这次是到点触发）。'
   : intervalMinutes > 0
    ? '这次是你让它看的；定时开着，每 ' + intervalMinutes + ' 分钟它自己也会醒。'
    : '这次是你让它看的；没有开启定时，它不会自己醒。',
  startedAt,
  finishedAt: new Date().toISOString(),
  outcome: errors.length ? 'failed' : 'ok',
  looked, candidates, silenced, errors,
 };
 // 每次留痕都要写明"看不到什么"：日历/飞书/钉钉都没接入，这是长期事实，
 // 不许假装看过，也不许因为"没接"就一条不留（那样"为什么没打扰你"会永远空着）。
 record.silenced.push({rule: '整体', subjectId: null, title: null, what: '外部连接器（日历 / 飞书 / 钉钉）',
  why: '都没接入，外面发生了什么看不到 —— 不是没看，是看不到'});
 if (!record.looked.length && !errors.length) {
  record.silenced.push({rule: '整体', subjectId: null, title: null, what: '工作台里的对象', why: '没有可判断的对象'});
 }
 // 数目必须在**补完如实说明之后**再算：否则 counts 和数组对不上（测试当场抓到过）。
 // 出声判定（批次 8）：每条"值得找你"的都要定级，并把"为什么现在告诉你"与降级原因写下来。
 if (typeof speak === 'function') {
  record.spoken = [];
  for (const candidate of candidates) {
   const decision = speak(candidate) ?? {};
   record.spoken.push({rule: candidate.rule, subjectId: candidate.subjectId, title: candidate.title,
    level: decision.level ?? 1, why: decision.why ?? candidate.why, delivery: decision.delivery ?? 'ranked',
    degraded: decision.degraded === true, degradation: decision.degradation ?? null});
  }
 }
 record.counts = {looked: looked.length, candidates: candidates.length, silenced: silenced.length, errors: errors.length};
 return record;
}

export {FAILURE_ALERT_THRESHOLD};
