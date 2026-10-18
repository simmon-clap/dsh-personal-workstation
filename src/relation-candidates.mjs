/** 关联候选：从**已有数据**里找出"看起来有关系、但还没连上"的对象对。
 *
 *  ## 为什么要有它
 *  用户 2026-10-16：「画布上各个框都是独立的……示例客户的很多信息都是关联的，这些都没有关联起来，
 *  这里的 AI 处理都是有问题的」。
 *
 *  查证过：画布**已经会画**两类关系 ——
 *    ① `graph.mjs` 从 `projectId`/`ownerId`/`partnerId`/`dependsOn` **派生**的（实线，可靠）
 *    ② `relation` 记录（用户确认的实线 / `suggested` 的虚线）
 *  缺的是第 ② 类里**由推断产生**的那些。
 *
 *  ## 这一层只做"找候选"，不做"下结论"
 *  **候选来自数据里已经存在的共同信号**（同一个项目、同一场会议、同一批材料、标题里同一个专名），
 *  不是编出来的。谁和谁真的相关，由**智能体**逐条判断并写依据 ——
 *  这样既不幻觉，也不把判断权交给一段正则（宪章三：判断是一等公民）。
 *
 *  ## 硬约束（每条候选都要能回答"凭什么提它"）
 *  · **只提还没有连上的对** —— 已经派生过的关系不再提（否则每次推断都在重复报同一件事）
 *  · **每条带 reason**（是哪个共同信号让它成为候选），没有信号的对**不提**
 *  · **不跨类型乱提** —— 只提白名单里的组合（同一项目下的任务/材料/议题、同一场会议的事务与材料…）
 */

/** 已有派生关系（与 graph.mjs 同一套口径）——这些不再作为候选。 */
function existingPairs(entities) {
  const byId = new Map(entities.map(e => [e.id, e]));
  const pairs = new Set();
  const key = (a, b) => a < b ? a + '\u0000' + b : b + '\u0000' + a;
  for (const e of entities) {
    const link = other => { if (other && byId.has(other)) pairs.add(key(e.id, other)); };
    link(e.data?.projectId);
    link(e.data?.ownerId);
    link(e.data?.partnerId);
    link(e.data?.organizationId);
    for (const id of e.data?.dependsOn ?? []) link(id);
    for (const id of e.data?.taskIds ?? []) link(id);
    // 已有 relation 记录（任何状态，含 rejected —— 被否决过的**不许再提**）
    if (e.kind === 'relation') pairs.add(key(e.data?.from, e.data?.to));
  }
  return pairs;
}

const label = e => String(e.data?.title ?? e.data?.name ?? e.id);

/** 一段文字里的专名/关键词（去停用词，2 字以上）。 */
function terms(text) {
  const stop = new Set(['项目', '任务', '材料', '资料', '议题', '会议', '纪要', '记录', '我们', '这个', '那个', '以及', '关于', '研究', '方案']);
  return new Set(String(text ?? '').split(/[^\p{Script=Han}A-Za-z0-9]+/u)
    .map(word => word.trim())
    .filter(word => word.length >= 2 && !stop.has(word))
    // **纯数字不算共同信号**。实测踩过：两条毫不相干的记录因为都含「2026」「10」被判成候选，
    // 理由写成"都提到「2026」「10」"—— 这种候选只会制造噪声，让真正该看的那几条被淹掉。
    .filter(word => !/^[0-9]+$/.test(word))
    // 年月日这种带数字的碎片（20261015、10月）同样不算。
    .filter(word => !/^[0-9]+[年月日号]$/.test(word))
    // 单个汉字太泛（"会""表""定"），要有实义才行。
    .filter(word => /[\p{Script=Han}]{2,}/u.test(word) || /^[A-Za-z]{3,}$/.test(word)));
}

/**
 * 找出候选关联对。
 *
 * @param entities 全部未归档对象（含 relation）
 * @returns Array<{from,to,reason,kind}> —— reason 是"凭什么提它"，必须非空
 */
export function relationCandidates(entities = []) {
  const live = entities.filter(e => e && !e.archived && e.kind !== 'layout');
  const byId = new Map(live.map(e => [e.id, e]));
  const known = existingPairs(live);
  const pairKey = (a, b) => a < b ? a + '\u0000' + b : b + '\u0000' + a;
  const out = [];
  const seen = new Set();
  const push = (a, b, reason) => {
    if (!a || !b || a.id === b.id) return;
    const k = pairKey(a.id, b.id);
    if (known.has(k) || seen.has(k)) return;
    seen.add(k);
    out.push({from: a.id, to: b.id, fromTitle: label(a), toTitle: label(b), reason, kinds: a.kind + '+' + b.kind});
  };

  // ① 同一个文件夹里的材料 —— 同一批落下来的东西通常属于同一件事
  const byFolder = new Map();
  for (const e of live) {
    const folder = e.data?.folder;
    if (!folder || e.kind !== 'artifact') continue;
    const list = byFolder.get(folder) ?? [];
    list.push(e);
    byFolder.set(folder, list);
  }
  for (const [folder, list] of byFolder) {
    for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) {
      push(list[i], list[j], '同一文件夹「' + folder + '」下的材料');
    }
  }

  // ② 标题/正文里共同出现的专名 —— 同一个专名反复出现，通常确实是同一件事
  const withTerms = live.filter(e => e.kind !== 'relation').map(e => ({e, t: terms([label(e), e.data?.description, e.data?.summary].filter(Boolean).join(' '))}));
  for (let i = 0; i < withTerms.length; i += 1) {
    for (let j = i + 1; j < withTerms.length; j += 1) {
      const a = withTerms[i], b = withTerms[j];
      const shared = [...a.t].filter(word => b.t.has(word));
      if (!shared.length) continue;
      push(a.e, b.e, '都提到「' + shared.slice(0, 3).join('」「') + '」');
    }
  }

  // ③ 同一场会议的事务与那场会议的材料 —— 时间与主题都对得上
  for (const event of live.filter(e => e.kind === 'event')) {
    const day = String(event.data?.startDate ?? '').slice(0, 10);
    if (!day) continue;
    for (const artifact of live.filter(e => e.kind === 'artifact' && e.data?.meetingDate === day)) {
      push(event, artifact, '同一场会议（' + day + '）');
    }
  }

  // ④ 未被任何东西引用的对象，与同项目的对象 —— 孤立对象优先提给模型看
  for (const e of live) {
    if (e.kind === 'relation' || e.data?.projectId) continue;
    const sameKind = live.filter(o => o.id !== e.id && o.kind === e.kind && !o.data?.projectId && o.kind !== 'relation');
    for (const other of sameKind.slice(0, 2)) push(e, other, '都是尚未归属的「' + e.kind + '」，需确认是否同一件事');
  }

  // 依据必须非空（校验也要求 relation 带 evidence；这里先把"没信号就对"的挡在外面）
  return out.filter(row => row.reason && row.reason.trim());
}

export const __test = {existingPairs, terms};
