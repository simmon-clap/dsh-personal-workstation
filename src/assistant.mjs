import {runHeartbeat} from './heartbeat.mjs';
import {selectForAnchor, anchorOf} from './judge.mjs';

/** 助理后台的编排：到开口点醒来一次（spec/55 P3）。
 *
 *  一次开口 = 判定 → 判断 → 记录。三件事必须**一起**留痕：
 *    · 判定看到了什么（heartbeat_runs）
 *    · 端出了哪几条、筛掉了什么（opening）
 *    · 说没说、为什么（opening.skipped）
 *
 *  ## 谁负责开口
 *  按宪章 v1.4 第七条「承诺不对称」：开口是**常驻节点**的事。
 *  笔记本是副本，它会同步到同一条 openning 记录，但不自己开口 ——
 *  否则两端各说一次，用户第一周就会关掉它。
 *
 *  ## 成本
 *  判定是纯规则（0 token）；判断层是纯函数（0 token）。
 *  只有把三句写成一段人话时才需要模型，那一步在出口层（P4），不在这里。
 */

/** 现在该不该开口：是锚点时间，且这个锚点今天还没开过口。 */
export function shouldOpen({openings, ctx, now = new Date(), windowMinutes = 30} = {}) {
 const anchor = anchorOf(now, {windowMinutes});
 if (!anchor) return {open: false, anchor: null, why: '现在不是开口点'};
 if (!openings) return {open: false, anchor, why: '开口记录未接入'};
 if (openings.openedToday(ctx, {anchor, now})) return {open: false, anchor, why: '这个开口点今天已经开过口了'};
 return {open: true, anchor, why: '到点了'};
}

/**
 * 跑一次开口：判定 → 三问筛选 → 记录。
 * @returns {anchor, run, opening, opened}
 */
export function runOpening({store, ctx, heartbeat, loop = null, openings, judge = null,
 now = new Date(), cap = 5, windowMinutes = 30} = {}) {
 const decision = shouldOpen({openings, ctx, now, windowMinutes});
 if (!decision.open) return {anchor: decision.anchor, opened: false, why: decision.why, run: null, opening: null};

 const previous = heartbeat?.status?.(ctx) ?? {};
 const run = runHeartbeat({store, ctx, now, loop, since: previous.lastSuccessAt ?? null,
  scheduled: true, intervalMinutes: 0});
 heartbeat?.record?.(ctx, run);

 const selected = (judge ?? selectForAnchor)(run.candidates ?? [], {anchor: decision.anchor, cap, now});
 const opening = openings.record(ctx, {
  anchor: decision.anchor,
  items: selected.items,
  skipped: selected.skipped,
  summary: selected.summary,
  runId: run.startedAt ?? null,
  at: now.toISOString(),
 });
 return {anchor: decision.anchor, opened: true, why: decision.why, run, opening};
}
