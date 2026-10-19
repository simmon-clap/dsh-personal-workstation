/** 建议闭环（宪章第四条）。
 *
 *  宪章第四条要求建议**必须闭环**，三条硬约束：
 *    ① 机器给建议，人做取舍；
 *    ② 每条建议都要带**依据**与**不确定性**（不能只给结论）；
 *    ③ 没有回应就不是闭环 —— 建议要落到一个能"同意 / 不同意 / 稍后再决定"的地方。
 *
 *  为什么单独一个模块：在这之前，工作台只有"提醒"（心跳按规则数出待办，属于**出声**），
 *  没有"建议"（看到一件事已经成立、据此提出一次改动）。`spec/03 §8` 自评把这一块标成
 *  「缺（最高优先）」——用户 2026-10-14 的原话也是这个意思：「对交付材料确认后就自动进行
 *  阶段定义，如果有差异了则点击确认，或者在收件箱里体现就好了」。
 *
 *  与"自动改"的边界（宪章第五条）：机器**只在做事层面主动**——它可以自己去看交付项、
 *  自己判断"是不是都做完了"；但"要不要把项目推进到下一阶段"是**你要负责的取舍**，
 *  所以结论只能变成一条**待你决定的建议**，不能直接写进库。
 *
 *  用法：
 *    const advice = buildAdvice({store, ctx, now});
 *    advice.suggestions   // 生成了什么（给日志/简报用）
 *    advice.drafted       // 写进了收件箱的批次 id
 */
import {randomUUID} from 'node:crypto';

const PHASES = ['接触', '需求', '方案', '验证', '复盘'];

const isDone = entry => entry?.done === true || entry?.status === 'done';
const nextPhaseOf = stage => {
  const index = PHASES.indexOf(stage);
  return index >= 0 && index < PHASES.length - 1 ? PHASES[index + 1] : null;
};

/**
 * 找一个"该推进但没推进"的项目，生成一条建议。
 *
 * 只在**结论已经成立**时才提：全部交付项都完成了。没完成就不提 ——
 * "还有 3 项没做完，建议推进"不是建议，是噪音（宪章六·安静）。
 */
export function stageAdvanceAdvice({store, ctx, now = new Date()} = {}) {
  const projects = store.list(ctx, {kind: 'project', limit: 500});
  const tasks = store.list(ctx, {kind: 'task', limit: 1000});
  const artifacts = store.list(ctx, {kind: 'artifact', limit: 1000});
  const out = [];
  for (const project of projects) {
    if (project.archived) continue;
    const data = project.data ?? {};
    const stage = data.stage;
    const next = nextPhaseOf(stage);
    if (!stage || !next) continue;                       // 没阶段 / 已经是最后一阶段：不提
    const deliverables = (data.deliverables ?? []).filter(entry => entry && entry.title);
    if (!deliverables.length) continue;                  // 什么都没拆出来：无从判断"做完了"
    const undone = deliverables.filter(entry => !isDone(entry));
    if (undone.length) continue;                         // 还有没做完的：不值得打扰

    // 依据：逐条给出"是哪几项完成了"。这是让人能核对的东西，不是一句"系统认为可以推进"。
    // `verified` 是**是否经第三方验证**（spec/03 §10）：完成状态来自工作台自己的记录，
    // 没有第三方核过 —— 标 true 是自吹（宪章六·诚实）。
    const evidence = deliverables.slice(0, 20).map(entry => ({
      kind: 'note',
      ref: project.id,
      quote: '交付项「' + entry.title + '」已完成',
      verified: false,
    }));

    // 「为什么这么建议」的取数（F12）：**真的读了哪几条判断**才写进 basedOn。
    // 读不到就留空 —— 界面会自曝"通用建议"（宪章四·硬约束 2：列不出来就必须自曝）。
    // 2026-10-16 修：原来把「交付项标题」当 basedOn 放在对象顶层，而 writeDraft 只解构 proposal，
    // 于是**被静默丢弃** —— 真实建议永远走"自曝通用建议"那条路，F12 从来没用过。
    const judgments = store.list(ctx, {kind: 'judgment', projectId: project.id, limit: 500}).filter(entry => !entry.archived);
    const checking = judgments.filter(entry => (entry.data?.status ?? 'current') === 'checking');
    const basedOn = checking.slice(0, 8).map(entry => entry.id);
    // 不确定性：如实说出"这个结论还缺什么"。宁可说得保守，也不假装万无一失。
    const openTasks = tasks.filter(task => !task.archived && task.data?.projectId === project.id
      && !['done', 'cancelled'].includes(task.data?.status));
    const linkedFiles = artifacts.filter(file => !file.archived && file.data?.projectId === project.id);
    const unverified = Number(linkedFiles.filter(file => !file.data?.verification?.status).length);
    const parts = [];
    if (openTasks.length) parts.push(openTasks.length + ' 个任务还没完成');
    if (unverified) parts.push(unverified + ' 份材料还没核对来源');
    if (checking.length) parts.push(checking.length + ' 条判断还没核对（建议里已经把它们算进去了）');
    const uncertainty = parts.length
      ? '交付项都完成了，但' + parts.join('、') + ' —— 阶段推进只改阶段与时间，不影响它们。'
      : '交付项都完成了；未发现其它未了事项。';

    out.push({
      project,
      stage,
      next,
      title: '建议把「' + (data.title ?? project.id) + '」推进到「' + next + '」',
      changes: [{
        op: 'update',
        id: project.id,
        expectedRevision: project.revision,
        data: {
          ...data,
          stage: next,
          stageHistory: [...(data.stageHistory ?? []), {stage: next, at: now.toISOString()}],
        },
      }],
      // basedOn 放在 proposal 里（writeDraft 只解构 {title,changes,source,proposal}；
      // 放在顶层会被静默丢弃 —— 2026-10-16 实测确认过）。没有依据时**整个字段不出现**，
      // 界面据此自曝"通用建议"，而不是拿一句空数组装样子。
      proposal: basedOn.length ? {evidence, uncertainty, basedOn} : {evidence, uncertainty},
    });
  }
  return out;
}

/**
 * 把建议写进收件箱（**不直接落库**）。
 * @returns {{suggestions: Array, drafted: Array<string>}}
 */
export function buildAdvice({store, ctx, now = new Date(), draftId = null} = {}) {
  const suggestions = stageAdvanceAdvice({store, ctx, now});
  const drafted = [];
  const pending = store.inbox(ctx, {status: 'draft'});
  // F14「被否决的不复活，除非有新证据」：被否决的建议状态是 cancelled，不在 pending 里，
  // 原来只查 pending → 同一句话第二天照样重提（2026-10-16 实测复现）。这里把它捞出来比。
  const decided = store.inbox(ctx, {status: 'cancelled', limit: 500});
  const sameTarget = (batch, item) => batch.author === 'agent'
    && batch.changes?.some(change => change.id === item.project.id && change.data?.stage === item.next);
  for (const item of suggestions) {
    // 同一条建议不要重复提：同一个项目、同一个目标阶段，已经有一条待决定的就不再加一条。
    if (pending.some(batch => sameTarget(batch, item))) continue;
    // 已经否决过、而项目**从那以后没变过** → 不再提（你说的"不用了"要算数）。
    // 项目真的变了（版本号变了）= 有新证据，才允许重新提一次。
    const rejectedUnchanged = decided.some(batch => sameTarget(batch, item)
      && batch.changes?.some(change => change.id === item.project.id && change.expectedRevision === item.project.revision));
    if (rejectedUnchanged) continue;
    // 关键：作者必须是 agent。契约②按**谁发起**决定要不要确认 ——
    // 这条建议是机器提出的，所以它只能是"待你决定的一条"，绝不直接生效。
    const agentCtx = {...ctx, actor: 'agent'};
    const id = store.draft(agentCtx, {
      title: item.title,
      changes: item.changes,
      proposal: item.proposal,
      source: {kind: 'advice', rule: 'stage-advance', subjectId: item.project.id},
    }, draftId ? draftId + '-' + item.project.id.slice(0, 8) : randomUUID());
    drafted.push(id);
  }
  return {suggestions, drafted};
}

export {PHASES, nextPhaseOf};
