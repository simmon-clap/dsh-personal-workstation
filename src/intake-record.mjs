/** 把一次「已经落地的输入」记进收件本（spec/03 §13 · spec/55 P1）。
 *
 *  为什么放在 commit 之后、而不是之前：
 *  「接住」的定义是**这条输入有下文**。草稿被否掉、被撤销，本来就没有下文，
 *  不该在收件本里留下一条"记下了"；只有真正提交的改动才算接住。
 *
 *  为什么失败不许影响主流程：
 *  收件本是账本，不是业务。记账失败最坏是少一条留痕；让它把「用户刚提交的改动」一起失败，
 *  就成了本末倒置。所以这里吞掉异常并记一条审计，而不是往上抛。
 */

/** 一次提交里"新出现"的对象（用于给收件本一条归属）。 */
const createdIn = receipt => {
 const before = new Set((receipt?.before ?? []).filter(Boolean).map(item => item.id));
 return (receipt?.after ?? []).filter(item => item && !before.has(item.id));
};

/**
 * @returns 写入的那条收件记录；失败返回 null（不影响调用方）
 */
export function recordCommittedIntake({intake, store, ctx, source, batchId, receipt, logger = null}) {
 if (!intake) return null;
 try {
  const batch = typeof store?.batch === 'function' ? store.batch(ctx, batchId) : null;
  const created = createdIn(receipt);
  const title = String(batch?.title ?? '').trim();
  const what = title || '一次改动';
  // 摘要只写"这次输入落成了什么"，不抄内容 —— 正文在对象里，收件本不做第二份来源。
  const summary = (created.length
   ? what + '（新建 ' + created.length + ' 个）'
   : what).slice(0, 200);
  const first = created[0] ?? null;
  return intake.append(ctx, {
   source,
   summary,
   state: 'captured',
   sourceRef: batchId ?? null,
   subjectKind: first?.kind ?? null,
   subjectId: first?.id ?? null,
   at: receipt?.at ?? new Date().toISOString(),
  });
 } catch (error) {
  // 记账失败不改业务结果，但必须留痕（否则"没收进去"会变成静默丢失）。
  logger?.('intake_record_failed', error);
  return null;
 }
}

/** 这次输入是从哪个口进来的（spec/03 §13 入口矩阵）。
 *  DSH 的 IM 会话 id 形如 `im:feishu_…:dm:…`，其余算工作台内对话。
 *  只做归类，不做"哪个更重要"的判断 —— 权重属于 P3 判断层。 */
export function sourceForSession(sessionId, fallback = 'chat') {
 const id = String(sessionId ?? '');
 if (id.startsWith('im:')) return 'im';
 if (id.startsWith('voice:') || id.startsWith('audio:')) return 'voice';
 return fallback;
}

/** 记一条"已经接住但没有落到某个对象"的输入（语音转写、IM 收到的一条消息等）。
 *  与 recordCommittedIntake 共用同一条纪律：记账失败不许反噬业务。 */
export function recordIntakeSafely({intake, ctx, source, summary, sourceRef = null}) {
 if (!intake) return null;
 try {
  return intake.append(ctx, {source, summary, state: 'captured', sourceRef});
 } catch {
  return null;
 }
}
