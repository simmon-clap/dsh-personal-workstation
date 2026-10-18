/** 信息简报引擎（宪章四 · 建议闭环；用户 2026-10-15 定的四类）。
 *
 *  用户原话：「简报应该是对我的**事务性工作**有呈现，让我不要忘了待办」，以及
 *  「我把你当助理，你不能给我所有的信息吧？你应该做出判断然后告诉我」。
 *
 *  所以简报**不是信息汇总**，是**判断**：每条三行 ——
 *    ① 我认为什么（一句话结论）
 *    ② 凭什么（依据，可核对的具体条目）
 *    ③ 你只需要回一句（一个动作）
 *
 *  ## 四类（只报"你不知道就会有损失"的）
 *    到期   —— 今天/明天到期的承诺
 *    卡住   —— 等待超期、或阻塞没写原因
 *    新进展 —— 自上次简报后新进来的东西
 *    该复核 —— 判断到了复核时间
 *
 *  ## 三条硬约束（都来自宪章）
 *    · **没内容就不生成**（宪章六·安静）：一段都没有时返回 `empty: true`，不产出空简报。
 *    · **每条都要能回答"为什么现在告诉你"**（宪章四）：`why` 字段必填。
 *    · **只报增量 + 到期**（克制）：处理过的不再出现；到期是硬提醒，不因为"昨天看过"就消失。
 *      这是它与"总览/看板/收件箱"那四处列表的分工 —— 简报不重复它们。
 *
 *  ## 与"出声预算"的关系
 *  简报是**主动出声**，受宪章六「主动不等于打扰」约束：一天两条（09:30 / 21:00），
 *  紧急项即时插播。本模块只负责**算**，不负责发 —— 发声由心跳与 IM 通道决定。
 */
const DAY = 24 * 60 * 60 * 1000;

const asDate = value => {
  if (!value) return null;
  const text = String(value).trim();
  const date = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text) ? text.replace(' ', 'T') : text);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** 距今天还有几天（今天=0，明天=1，过期=负数）。 */
export function daysUntil(value, now = new Date()) {
  const date = asDate(value);
  if (!date) return null;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((target - start) / DAY);
}

const OPEN_TASK = new Set(['todo', 'waiting', 'in_progress']);
const isOpen = task => !task.archived && OPEN_TASK.has(task.data?.status ?? 'todo');

const dueWord = days => (days < 0 ? `已经过期 ${Math.abs(days)} 天` : days === 0 ? '今天到期' : days === 1 ? '明天到期' : `还有 ${days} 天到期`);

/**
 * 算一份简报。
 *
 * @param store 工作台数据
 * @param ctx   读写上下文
 * @param now   当前时间
 * @param since 上次简报时间（用于"新进展"）；缺省时只看最近一天
 * @returns {{empty: boolean, sections: Array, at: string}}
 */
export function buildBriefing({store, ctx, now = new Date(), since = null} = {}) {
  const tasks = store.list(ctx, {kind: 'task', limit: 1000});
  const events = store.list(ctx, {kind: 'event', limit: 1000});
  const projects = store.list(ctx, {kind: 'project', limit: 500});
  const topics = store.list(ctx, {kind: 'topic', limit: 500});
  const judgments = store.list(ctx, {kind: 'judgment', limit: 500});
  const artifacts = store.list(ctx, {kind: 'artifact', limit: 1000});
  const sinceAt = since ? asDate(since) : new Date(now.getTime() - DAY);

  const sections = [];
  const push = (kind, title, items) => { if (items.length) sections.push({kind, title, items}); };

  // ① 到期 —— 硬提醒。有确定日期的承诺：任务截止 + 今天的事务。
  const due = [];
  for (const task of tasks) {
    if (!isOpen(task)) continue;
    const days = daysUntil(task.data?.dueDate, now);
    if (days === null || days > 1) continue;
    due.push({
      subjectId: task.id,
      what: `${task.data.title ?? task.id} —— ${dueWord(days)}`,
      why: days < 0 ? '已经过期，还没标记完成' : '今天/明天到期',
      evidence: [`截止日期 ${String(task.data.dueDate).slice(0, 10)}`,
        task.data.projectId ? `属于项目 ${projects.find(p => p.id === task.data.projectId)?.data?.title ?? task.data.projectId}` : '未归属项目'],
      action: '说要「完成」还是「延期」',
      // 明确结论 → 直接闭环（契约②：自己的操作直接生效 + 左下可撤销）。
      resolve: {id: task.id, label: '标记完成', patch: {status: 'done'}},
    });
  }
  for (const event of events) {
    if (event.archived) continue;
    const days = daysUntil(event.data?.startDate, now);
    if (days !== 0) continue;                       // 事务只报"今天"
    due.push({
      subjectId: event.id,
      what: `${event.data.title ?? event.id} —— 今天`,
      why: '今天的事务',
      evidence: [event.data.location ? `地点 ${event.data.location}` : '地点未记录'],
      action: '确认时间地点，或说「改期」',
    });
  }
  push('due', '今天要处理的', due);

  // ② 卡住 —— 等待中的任务。合同：等待必须能说清"等谁/等什么"，没填就如实说没填。
  const stuck = [];
  for (const task of tasks) {
    if (task.archived || task.data?.status !== 'waiting') continue;
    const days = daysUntil(task.data?.dueDate, now);
    const reason = String(task.data?.blockedReason ?? '').trim();
    stuck.push({
      subjectId: task.id,
      what: `${task.data.title ?? task.id} —— 卡在等待`,
      why: reason ? `等待原因：${reason}` : '没写等待原因（说不清在等什么）',
      evidence: [reason ? '你自己写的等待原因' : '等待原因未记录',
        days === null ? '没有截止日期' : dueWord(days)],
      action: reason ? '说「继续等」或「不等了」' : '补一句在等什么',
      resolve: {id: task.id, label: '不再等，恢复待办', patch: {status: 'todo', blockedReason: ''}},
    });
  }
  push('stuck', '卡住的', stuck);

  // ③ 新进展 —— 自上次简报后新登记/更新的东西。**只报增量**，处理过的不再出现。
  const fresh = [];
  const freshOf = (kind, label, pick) => {
    for (const item of store.list(ctx, {kind, limit: 200})) {
      if (item.archived) continue;
      const at = asDate(item.updatedAt ?? item.at);
      if (!at || at < sinceAt) continue;
      fresh.push({
        subjectId: item.id,
        what: `${label}：${item.data?.title ?? item.data?.name ?? item.id}`,
        why: '自上次简报后新进来/有更新',
        evidence: [pick ? pick(item) : '工作台里的记录'],
        action: '说「知道了」或「展开说」',
      });
    }
  };
  freshOf('topic', '新议题', item => item.data?.description ? String(item.data.description).slice(0, 60) : '尚无描述');
  freshOf('artifact', '新材料', item => item.data?.path ? `文件 ${item.data.path}` : '未记录路径');
  freshOf('brief', '新简报', item => item.data?.source ? `来源 ${item.data.source}` : '来源未记录');
  push('fresh', '有新东西', fresh.slice(0, 8));

  // ④ 该复核 —— 判断到了复核时间（宪章三：判断是有寿命的）。
  const review = [];
  for (const judgment of judgments) {
    if (judgment.archived) continue;
    const days = daysUntil(judgment.data?.reviewBy, now);
    if (days === null || days > 0) continue;
    review.push({
      subjectId: judgment.id,
      what: `${judgment.data?.title ?? judgment.id} —— 到了该复核的时间`,
      why: days === 0 ? '今天到期复核' : `复核时间已过 ${Math.abs(days)} 天`,
      evidence: [`复核时间 ${String(judgment.data.reviewBy).slice(0, 10)}`,
        judgment.data?.uncertainty ? `当时标的不确定性：${judgment.data.uncertainty}` : '当时没标不确定性'],
      action: '说「仍然成立」或「推翻了」',
      resolve: {id: judgment.id, label: '仍然成立', patch: {status: 'current'}},
    });
  }
  push('review', '该复核的判断', review);

  return {
    empty: sections.length === 0,
    at: now.toISOString(),
    headline: sections.length ? `${sections.reduce((sum, s) => sum + s.items.length, 0)} 件事要你知道` : '今天没什么要你处理的',
    sections,
  };
}

/** 简报的记录形态（能落库、能留痕、能回答"我说过什么"）。 */
export function briefingDocument(briefing) {
  const lines = [];
  for (const section of briefing.sections) {
    lines.push('## ' + section.title);
    for (const item of section.items) {
      lines.push(`- ${item.what}`);
      lines.push(`  为什么现在告诉你：${item.why}`);
      for (const line of item.evidence ?? []) lines.push(`  依据：${line}`);
      lines.push(`  你可以：${item.action}`);
    }
  }
  return lines.join('\n');
}
