/**
 * 出声判定（F23，批次 8）：**额度、三扇门、四级、免打扰、双向计量**。
 *
 * 依据：[spec/03 §6 ①–⑦](功能与交互设计) 与 §11「出声额度：可调初值」、§12 命名澄清。
 * 设计立场（宪章第六条 安静）：**克制是默认，主动是挣来的，委托是例外，漏报是刹车。**
 *
 * 两条不可让渡：
 *  1. **额度由你的反馈决定**：照着做了 +8 · 知道了 +2 · 别再提醒 −10 · 直接忽略 −3；
 *     长时间不出声 **不涨**（不许靠"憋着"涨额度）。
 *  2. **通道没核实就不许说"已能推送"**：飞书出声复用 IM 助理渠道，工作台当前没有发送代码，
 *     所以二级出声在这里**降级为一级**，并把降级原因写在结论里（§11 末段）。
 *
 * 本模块是**纯函数**：不碰存储、不发消息，只根据反馈与当前处境算"这一条该用什么级别、为什么"。
 */
export const BUDGET_INITIAL = 40;
/** 反馈对额度的影响（03 §11，可调初值）。 */
export const FEEDBACK_DELTA = {followed: 8, noted: 2, unnecessary: -10, ignored: -3, missed: 0};

export const budgetOf = feedback => {
 const total = (feedback ?? []).reduce((sum, item) => sum + (FEEDBACK_DELTA[item?.kind] ?? 0), 0);
 return Math.max(0, Math.min(100, BUDGET_INITIAL + total));
};
export const stageOf = budget => budget < 30 ? '陌生期' : budget < 70 ? '试用期' : '信任期';
/** 二级出声每周上限 = 1 + 额度 // 25（40 → 2 次，70 → 3 次，100 → 5 次）。 */
export const weeklySecondaryLimit = budget => 1 + Math.floor(budget / 25);
/** 免打扰窗口：22:00–08:00 加周末；窗口内一律降为一级/零级。 */
export const inQuietWindow = (now = new Date()) => {
 const hour = now.getHours(), day = now.getDay();
 return day === 0 || day === 6 || hour >= 22 || hour < 8;
};
export const QUIET_NOTE = '免打扰时段（22:00–08:00 或周末）：只排序，不打断';

/** "该说没说"：你标记后，该类条件的门槛下调一档（03 §11）。一档就够，不做无限放宽。 */
export const thresholdShift = (missed, rule) => ((missed?.[rule] ?? 0) > 0 ? 1 : 0);

/** 永不出声的四类（03 §6 ③）：无来源内容 · 兴趣类简报 · 重复提醒 · 已否决建议。 */
export function neverSpeak(candidate) {
 if (candidate?.source === null || candidate?.noSource) return '没有来源的内容不出声';
 if (candidate?.interest) return '兴趣类内容不出声';
 if (candidate?.repeated) return '重复提醒不出声';
 if (candidate?.rejected) return '你已经否决过，不复活';
 return null;
}

/**
 * 定级。返回 {level, why, degraded, delivery}：
 *  · level 2 = 二级（唯一能打断你的级别）；1 = 排在最前；0 = 只存档；null = 永不出声。
 *  · delegated（你委托的）**不受额度限制**，但通道未接入时照样降级并写明。
 *  · delivery 只有 'none'（工作台当前没有发送代码）——不许写成已推送。
 */
export function decideLevel(candidate, {
 budget = BUDGET_INITIAL,
 now = new Date(),
 spokenThisWeek = {},       // {rule: 已按二级说过几次}
 delegated = false,
 channelReady = false,      // 飞书出声接口与载荷是否已核实
} = {}) {
 const never = neverSpeak(candidate);
 if (never) return {level: null, why: never, degraded: false, delivery: 'forbidden'};
 const stage = stageOf(budget);
 const wanted = candidate?.level ?? 1;
 const shift = thresholdShift(candidate?.missed, candidate?.rule);
 const days = Number.isFinite(candidate?.days) ? candidate.days - shift : null;

 // 委托是例外：一定出声，不受额度限制。
 if (delegated) return deliver(2, '你委托过这件事，一定告诉你', stage, channelReady);
 if (wanted < 2) return {level: wanted, why: candidate?.why ?? '排在前面，不打断', degraded: false, delivery: 'ranked'};

 const conditions = {
  // ① 与你明确承诺过的事直接相关，且到期/被阻塞
  commitment: candidate?.commitment === true && (days === null || days <= 0 || candidate?.overdue === true || days <= 1 + shift),
  // ② 有新的可核对事实
  fresh: candidate?.fresh === true,
  // ③ 同类此前没出过声（这一周内）
  firstOfKind: (spokenThisWeek[candidate?.rule] ?? 0) === 0,
 };
 const limit = weeklySecondaryLimit(budget);
 const used = Object.values(spokenThisWeek).reduce((sum, count) => sum + count, 0);
 const stageAllows = stage === '陌生期' ? candidate?.overdue === true : true;
 if (!conditions.commitment) return {level: 1, why: '还没有"错过就没了"的分量，先排在前面', degraded: false, delivery: 'ranked'};
 if (!conditions.fresh) return {level: 1, why: '没有新的可核对事实，先排在前面', degraded: false, delivery: 'ranked'};
 if (!conditions.firstOfKind) return {level: 1, why: '这一类这周已经说过，不重复不升级', degraded: false, delivery: 'ranked'};
 if (used >= limit) return {level: 1, why: '这周的出声次数已经用完（上限 ' + limit + ' 次），先排在前面', degraded: false, delivery: 'ranked'};
 if (!stageAllows) return {level: 1, why: stage + '：只有已经错过的事才打断你', degraded: false, delivery: 'ranked'};
 if (inQuietWindow(now)) return {level: 1, why: QUIET_NOTE, degraded: false, delivery: 'ranked'};
 return deliver(2, candidate?.why ?? '与你承诺过的事直接相关，且到期/被阻塞', stage, channelReady);
}
/** 二级的交付：通道没核实就降级为一级（§11 末段），并把原因留在结论里。 */
function deliver(level, why, stage, channelReady) {
 if (channelReady) return {level, why, degraded: false, delivery: 'feishu'};
 return {level: 1, why: why + '；但工作台没有发送代码（未实现发送），先排在最前面，不发消息', degraded: true, delivery: 'none',
  degradation: '工作台没有发送代码（未实现发送）：二级只排在最前面，不声称已能推送'};
}

/** 双向计量（§6 ⑤）：既记"说多了"，也记"该说没说"。 */
export function metering(feedback) {
 const count = kind => (feedback ?? []).filter(item => item.kind === kind).length;
 const spoken = ['followed', 'noted', 'unnecessary', 'ignored'].reduce((sum, kind) => sum + count(kind), 0);
 const unnecessary = count('unnecessary') + count('ignored');
 const missed = count('missed');
 return {
  spoken, followed: count('followed'), noted: count('noted'), unnecessary: count('unnecessary'), ignored: count('ignored'),
  missed,
  // 说多了：你说没必要或直接忽略的比例
  tooMuchRate: spoken ? Math.round((unnecessary / spoken) * 100) : 0,
  // 该说没说：你事后标记的次数（反向刹车，用来放宽条件）
  missedRate: spoken + missed ? Math.round((missed / (spoken + missed)) * 100) : 0,
 };
}

/** 汇总：额度和它背后的阶段、上限、计量，一次给界面与工具用。 */
export function speakState(feedback, {now = new Date()} = {}) {
 const budget = budgetOf(feedback);
 const missed = {};
 for (const item of feedback ?? []) if (item.kind === 'missed' && item.condition) missed[item.condition] = (missed[item.condition] ?? 0) + 1;
 return {
  budget, initial: BUDGET_INITIAL, stage: stageOf(budget),
  weeklySecondaryLimit: weeklySecondaryLimit(budget),
  quietWindow: {active: inQuietWindow(now), note: '22:00–08:00 与周末只排序，不打断'},
  channel: {...SPEAK_CHANNEL},
  thresholdShifts: missed,
  metering: metering(feedback),
  note: '额度由你的反馈决定；长时间不出声不会涨。',
 };
}

/** 「同类此前没出过声」用的统计：从留痕里数，不另存计数。
 *  只数**真的按二级说出去**的（level 2 且 delivery 不是 none）——降级为一级的不算"说过"，
 *  否则通道没接入时会出现"它以为自己说过了，其实你什么都没收到"。 */
/** 出声通道的真实状态：工作台**没有发送代码**，所以 ready 永远是 false，并明确写「未实现发送」。
 *  二级（重要）只排序到最前面，由人在 DSH/飞书里自己看到；不声称能推送。 */
export const SPEAK_CHANNEL = {ready: false, implemented: false, note: '工作台没有发送代码（未实现发送）：二级只排在最前面，不会自己发到飞书。'};

export function spokenThisWeek(records, now = new Date(), days = 7) {
 const since = now.getTime() - days * 86400000;
 const counts = {};
 for (const record of records ?? []) {
  if (!Array.isArray(record?.spoken)) continue;
  if (!(Date.parse(record.startedAt) >= since)) continue;
  for (const item of record.spoken) {
   if (item.level === 2 && item.delivery === 'feishu') counts[item.rule] = (counts[item.rule] ?? 0) + 1;
  }
 }
 return counts;
}
