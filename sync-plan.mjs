/** 双端同步的**判定逻辑**（纯函数，可测）。
 *
 *  为什么把它单独抽出来：原来这套逻辑长在 `sync-engine.mjs` 里，跟 ssh/SQLite 绑在一起，
 *  **没法测** —— 于是"删除会复活""覆盖只写单侧"这两个数据丢失级 bug 一直没被发现。
 *  抽出来之后就能用两个内存数据集把所有分支跑一遍（见 test/sync-plan.test.mjs）。
 *
 *  依据：宪章 v1.2 第七条多端 ——
 *    · 多端是**对等副本**，以较新的一次为准；
 *    · **删除必须留墓碑**（否则删除会被当成"对端新增"复活，且删除永远传不出去）；
 *    · **被覆盖的那一次必须在两端都留痕**。
 */

const keyOf = row => row.workspace + '\u0000' + row.id;

/** 新旧判据：revision 优先，相同看 at。返回 >0 表示 a 比 b 新。 */
export function newer(a, b) {
  const ra = Number(a.revision ?? 0), rb = Number(b.revision ?? 0);
  if (ra !== rb) return ra - rb;
  const ta = a.at || '', tb = b.at || '';
  if (ta === tb) return 0;
  return ta > tb ? 1 : -1;
}

/**
 * 算出两端各要做什么。
 * @param {{local:Array, remote:Array, localTombstones?:Array, remoteTombstones?:Array}} input
 * @returns {{upsertsLocal:Array, upsertsRemote:Array, tombstonesLocal:Array, tombstonesRemote:Array,
 *            deletesLocal:Array, deletesRemote:Array, overrides:Array, resurrected:Array}}
 */
export function planSync({local, remote, localTombstones = [], remoteTombstones = []}) {
  const L = new Map(local.map(r => [keyOf(r), r]));
  const R = new Map(remote.map(r => [keyOf(r), r]));
  const LT = new Map(localTombstones.map(r => [keyOf(r), r]));
  const RT = new Map(remoteTombstones.map(r => [keyOf(r), r]));

  const out = {
    upsertsLocal: [], upsertsRemote: [],
    tombstonesLocal: [], tombstonesRemote: [],
    deletesLocal: [], deletesRemote: [],
    // 墓碑被"更新的改动"推翻时（删除之后那东西又被改过），两端都要把墓碑撤掉，否则以后还会误删。
    tombstonesDrop: [],
    overrides: [], resurrected: [],
  };

  const keys = new Set([...L.keys(), ...R.keys(), ...LT.keys(), ...RT.keys()]);
  for (const key of keys) {
    const l = L.get(key), r = R.get(key), lt = LT.get(key), rt = RT.get(key);
    const where = {workspace: (l ?? r ?? lt ?? rt).workspace, id: (l ?? r ?? lt ?? rt).id};

    // ① 删除的一方：先处理墓碑。**墓碑优先于实体**，否则删掉的东西会被"对端还在"拉回来。
    if (lt && r) {
      // 墓碑比实体新 → 删除生效：删掉对端那份，把墓碑推过去。
      // 实体比墓碑新 → 删除之后它又被改过（= 新证据）→ 保住实体，撤掉本地墓碑，并留痕。
      if (newer(r, lt) > 0) {
        out.resurrected.push({...where, kind: r.kind, reason: '删除之后对端又改过它，按新证据保留', revision: r.revision, tombstoneRevision: lt.revision, at: r.at});
        out.tombstonesDrop.push({...where});
        out.upsertsLocal.push(r);
      } else {
        out.deletesRemote.push({...where, kind: r.kind});
        out.tombstonesRemote.push({...where, kind: lt.kind ?? r.kind, revision: lt.revision, at: lt.at});
        out.overrides.push({...where, kind: r.kind, winner: 'local', loserRevision: r.revision, winnerRevision: lt.revision, reason: '本地已删除（墓碑较新）'});
      }
      continue;
    }
    if (rt && l) {
      if (newer(l, rt) > 0) {
        out.resurrected.push({...where, kind: l.kind, reason: '删除之后本地又改过它，按新证据保留', revision: l.revision, tombstoneRevision: rt.revision, at: l.at});
        out.tombstonesDrop.push({...where});
        out.upsertsRemote.push(l);
      } else {
        out.deletesLocal.push({...where, kind: l.kind});
        out.tombstonesLocal.push({...where, kind: rt.kind ?? l.kind, revision: rt.revision, at: rt.at});
        out.overrides.push({...where, kind: l.kind, winner: 'remote', loserRevision: l.revision, winnerRevision: rt.revision, reason: '对端已删除（墓碑较新）'});
      }
      continue;
    }
    // ② 两边都只有墓碑：取较新的那个，让另一端对齐（防止一端删了、另一端又"复活"一次）
    if (lt && rt) {
      const cmp = newer(lt, rt);
      if (cmp > 0) out.tombstonesRemote.push({...where, kind: lt.kind, revision: lt.revision, at: lt.at});
      else if (cmp < 0) out.tombstonesLocal.push({...where, kind: rt.kind, revision: rt.revision, at: rt.at});
      continue;
    }
    // ③ 只有一侧有墓碑、另一侧既没实体也没墓碑 → 把墓碑补齐（否则以后被别的路径复活）
    if (lt && !r) { out.tombstonesRemote.push({...where, kind: lt.kind, revision: lt.revision, at: lt.at}); continue; }
    if (rt && !l) { out.tombstonesLocal.push({...where, kind: rt.kind, revision: rt.revision, at: rt.at}); continue; }

    // ④ 都没有墓碑：常规合并。
    if (l && !r) { out.upsertsRemote.push(l); continue; }
    if (r && !l) { out.upsertsLocal.push(r); continue; }
    const cmp = newer(l, r);
    if (cmp > 0) {
      out.upsertsRemote.push(l);
      out.overrides.push({...where, kind: l.kind, winner: 'local', loserRevision: r.revision, winnerRevision: l.revision, reason: '本地内容更新'});
    } else if (cmp < 0) {
      out.upsertsLocal.push(r);
      out.overrides.push({...where, kind: r.kind, winner: 'remote', loserRevision: l.revision, winnerRevision: r.revision, reason: '对端内容更新'});
    }
  }
  return out;
}

/**
 * 只增不改的记录表（心跳留痕、出声反馈、审计）怎么合：**按 id 取并集**。
 *
 * 这些是"它做过什么"的证据，不是可编辑的业务对象 —— 没有"谁覆盖谁"的问题，
 * 各端缺的补上即可（宪章 v1.2：状态与留痕对象也要跟着走，否则两台机器的
 * "上次成功时间""连续失败次数"永远对不上）。
 */
export function planLogSync(localRows, remoteRows) {
  const L = new Map(localRows.map(r => [keyOf(r), r]));
  const R = new Map(remoteRows.map(r => [keyOf(r), r]));
  const toLocal = [], toRemote = [];
  for (const [key, r] of R) if (!L.has(key)) toLocal.push(r);
  for (const [key, l] of L) if (!R.has(key)) toRemote.push(l);
  return {toLocal, toRemote};
}
