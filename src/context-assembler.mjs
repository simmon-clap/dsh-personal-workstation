import {DomainError} from './store.mjs';

/** W3-1 上下文装配器（26 §6 能力①）。
 *
 *  一次调用给 Agent 一份**当前输入相关**的紧凑上下文：
 *    相关对象 + 上次判断 + 承诺/待核对 + 最近会话要点 + 可用的知识/记忆证据。
 *  输出里每一项都必须带出处（对象 ID / 判断 ID / 会话 ID / 文档 chunk），
 *  读不到就明确写 `unavailable` / `no-grants`，不猜、不编。
 *
 *  只读：不写库、不产生批次、不调用模型。
 */
const KINDS = ['project', 'task', 'artifact', 'topic', 'event', 'judgment', 'memoryRef'];
const KIND_LIMIT = 5;
const SESSION_MESSAGES = 6;

const text = value => (typeof value === 'string' ? value.trim() : '');
const clip = (value, max) => {
  const valueText = text(value);
  return valueText.length > max ? valueText.slice(0, max) + '…' : valueText;
};
const day = value => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '');
const terms = query => {
  const raw = text(query).toLowerCase();
  const list = new Set();
  for (const part of raw.split(/[\s,，。;；、/()（）]+/)) if (part.length >= 2) list.add(part);
  // 中文没有空格：补齐二字词，避免整句只当一个大词匹配不到。
  const han = raw.replace(/[^\u4e00-\u9fff]/g, '');
  for (let index = 0; index + 1 < han.length && list.size < 24; index += 1) list.add(han.slice(index, index + 2));
  return [...list];
};
const haystack = data => [data.title, data.goal, data.description, data.content, data.uncertainty, ...(Array.isArray(data.tags) ? data.tags : [])]
  .map(text).join('\n').toLowerCase();
const matched = (item, words) => {
  if (!words.length || !item?.data) return false;
  const hay = haystack(item.data);
  return words.some(word => hay.includes(word));
};
const stamp = item => {
  const at = item?.at;
  return typeof at === 'string' ? at : '';
};

const brief = (item, extra = {}) => ({
  id: item.id,
  title: clip(item.data?.title ?? item.data?.name ?? '未命名', 80),
  ...extra,
});

/** 判断卡上真正要「核对」的是什么：优先用写下来的不确定性，其次用生效条件。 */
const checkOf = item => {
  const question = text(item.data?.uncertainty) || text(item.data?.validFrom) || '这条判断的依据是否仍然成立？';
  return {
    judgmentId: item.id,
    title: clip(item.data?.title, 80),
    question: clip(question, 180),
    whatCountsAsDone: text(item.data?.reviewBy) ? '复核日期：' + day(item.data.reviewBy) : '找到一条能确认或推翻它的原始出处',
  };
};

export async function assembleContext({store, ctx, query, projectId, taskId, knowledge = null, sessions = null, agentId, now = new Date(), limit = 5} = {}) {
  const keyword = text(query);
  if (!keyword) throw new DomainError('INVALID', '说一句要找什么（例如会议名、项目名或一个判断），我再装配上下文');
  if (keyword.length > 500) throw new DomainError('INVALID', '要找的内容太长了，请压到 500 字以内');
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new DomainError('INVALID', '条数应为 1–10');
  const words = terms(keyword);
  const related = {};
  for (const kind of ['project', 'task', 'artifact', 'topic', 'event']) {
    let rows = store.list(ctx, {kind, query: '', includeArchived: false, limit: 200});
    if (projectId) rows = rows.filter(row => row.id === projectId || row.data?.projectId === projectId);
    if (taskId) rows = rows.filter(row => row.id === taskId);
    const picked = rows.filter(row => matched(row, words)).slice(0, limit);
    related[kind] = picked.map(row => brief(row, {
      projectId: text(row.data?.projectId) || null,
      status: text(row.data?.status) || null,
      dueDate: day(row.data?.dueDate) || null,
      progress: kind === 'task' && Number.isFinite(row.data?.progress?.total)
        ? {done: Number(row.data.progress.done) || 0, total: Number(row.data.progress.total) || 0}
        : null,
    }));
  }

  const judgments = store.list(ctx, {kind: 'judgment', query: '', includeArchived: false, limit: 200})
    .sort((left, right) => stamp(right).localeCompare(stamp(left)));
  const last = judgments[0] ?? null;
  const lastJudgment = last ? {
    id: last.id,
    title: clip(last.data?.title, 100),
    status: text(last.data?.status) || null,
    evidenceCount: Array.isArray(last.data?.evidence) ? last.data.evidence.length : 0,
    uncertainty: clip(last.data?.uncertainty, 180) || null,
    validFrom: day(last.data?.validFrom) || null,
    reviewBy: day(last.data?.reviewBy) || null,
    at: stamp(last) || null,
  } : null;

  const pendingChecks = judgments
    .filter(row => row.id !== last?.id && (text(row.data?.status) === 'checking' || text(row.data?.uncertainty)))
    .slice(0, limit)
    .map(checkOf);

  const today = day(now.toISOString());
  const soon = day(new Date(now.getTime() + 7 * 86400000).toISOString());
  const tasks = store.list(ctx, {kind: 'task', query: '', includeArchived: false, limit: 500});
  const openTasks = tasks.filter(row => !['done', 'cancelled'].includes(text(row.data?.status)));
  const promises = {
    overdue: openTasks.filter(row => day(row.data?.dueDate) && day(row.data.dueDate) < today).slice(0, limit)
      .map(row => brief(row, {dueDate: day(row.data.dueDate), status: text(row.data?.status) || null})),
    dueSoon: openTasks.filter(row => day(row.data?.dueDate) && day(row.data.dueDate) >= today && day(row.data.dueDate) <= soon).slice(0, limit)
      .map(row => brief(row, {dueDate: day(row.data.dueDate), status: text(row.data?.status) || null})),
    waiting: openTasks.filter(row => text(row.data?.status) === 'waiting').slice(0, limit)
      .map(row => brief(row, {blockedReason: clip(row.data?.blockedReason, 120) || null})),
  };

  // 最近会话要点：只读真实会话消息（用户/助理文字），工具调用与内部推理不进来。
  let recentSession = null;
  if (sessions && agentId) {
    const session = sessions.get(agentId);
    if (session && typeof session.deriveMessages === 'function') {
      const messages = session.deriveMessages()
        .filter(message => message.role === 'user' || message.role === 'assistant')
        .slice(-SESSION_MESSAGES)
        .map(message => ({
          role: message.role,
          text: clip((message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join(' '), 200),
        }))
        .filter(message => message.text);
      recentSession = {id: session.id, cwd: text(session.header?.cwd) || null, messages};
    }
  }

  // 知识证据：只在已授权知识库上检索；没有授权/服务未接入都如实返回状态，不伪造证据。
  // 上一轮你否决/改写过的建议理由（W3-D：下一轮要先读这些理由，再提新建议）。
  const recentAdviceFeedback = store.proposalHistory(ctx, {limit: 20})
    .filter(item => (item.decision === 'rejected' || item.decision === 'rewritten') && String(item.reason ?? '').trim())
    .slice(0, 3)
    .map(item => ({
      batchId: item.id,
      title: clip(item.title, 80),
      decision: item.decision === 'rejected' ? '你否决过' : '你改写后采纳',
      reason: clip(item.reason, 200),
      decidedAt: item.decidedAt ?? null,
    }));

  const memoryRefs = store.list(ctx, {kind: 'memoryRef', query: '', includeArchived: false, limit: 50})
    .filter(row => matched(row, words)).slice(0, limit)
    .map(row => brief(row, {quote: clip(row.data?.content, 160) || null, provider: text(row.data?.provider) || null, reference: text(row.data?.reference) || null, verification: row.data?.verification ?? null}));

  let knowledgeState = {status: 'not-configured', evidence: [], baseCount: 0};
  if (knowledge) {
    const grants = Array.isArray(knowledge.grants) ? knowledge.grants.filter(grant => grant.workspace === ctx.workspace) : [];
    if (grants.length) {
      const evidence = [];
      for (const grant of grants) {
        try {
          const result = await knowledge.search(ctx, {baseId: grant.baseId, query: keyword, topK: Math.min(limit, 5)});
          for (const hit of result.hits ?? []) {
            evidence.push({
              baseId: hit.baseId,
              docId: hit.docId,
              chunkId: hit.chunkId,
              documentTitle: clip(hit.documentTitle, 100),
              text: clip(hit.text, 240),
            });
            if (evidence.length >= limit) break;
          }
        } catch (error) {
          knowledgeState = {status: error?.code === 'UNAVAILABLE' ? 'unavailable' : 'error', evidence, baseCount: grants.length};
        }
        if (evidence.length >= limit) break;
      }
      if (knowledgeState.status === 'not-configured') knowledgeState = {status: 'ok', evidence, baseCount: grants.length};
    }
  }

  return {
    query: keyword,
    generatedAt: now.toISOString(),
    workspace: ctx.workspace,
    related,
    lastJudgment,
    pendingChecks,
    promises,
    recentSession,
    recentAdviceFeedback,
    memoryRefs,
    knowledge: knowledgeState,
  };
}
