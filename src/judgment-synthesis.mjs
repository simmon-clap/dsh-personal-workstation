import {DomainError} from './store.mjs';

/** W3-2 判断合成 / 矛盾检测（26 §6 能力②）。
 *
 *  分工（宪章第四条：机器给建议，人做取舍）：
 *    · 模型负责**读懂材料、起草判断**（它调 draft，走收件箱等用户同意）；
 *    · 插件只做**可复现的规则检查**：候选判断与既有判断是否在**同一主题**上给出相反结论，
 *      以及是否有人在用一条新判断覆盖已被推翻的旧判断。输出永远带**双方 id 与双方依据出处**。
 *
 *  不做语义幻觉检测——文本读不懂时宁可返回"没有找到矛盾"，也不猜。
 */
const STOP = new Set(['的', '了', '和', '与', '是', '在', '对', '这', '那', '一个', '一条', '问题', '情况', '当前', '目前', '可以', '不能', '没有', '并不', '已经', '仍', '还', '被', '把', '于', '及', '等', '更', '很', '有', '没', '会', '要', '需', '能', '不']);
// 「存在」是歧义词（真实存在 / 并不存在都含它）：先认强否定，再认肯定；两边都命中就算 unknown。
const POSITIVE = ['可行', '支持', '成立', '真实', '可以', '确实', '有效', '成功', '已核实', '已验证'];
const NEGATIVE = ['不可行', '不成立', '不存在', '虚假', '不能', '无法', '有风险', '风险', '缺', '难', '未核实', '未验证', '拒绝', '失败', '误判', '没有', '误读'];
const STATUS_LABEL = {current: '当前有效', checking: '待核对', overturned: '已被推翻'};

const norm = value => String(value ?? '')
  .replace(/（已被推翻）/g, '')
  .replace(/[，。；：、""''（）()《》【】[\]?？!！,.:;]/g, ' ')
  .toLowerCase();
const bigrams = value => {
  const text = norm(value).replace(/\s+/g, '');
  const out = new Set();
  for (let index = 0; index + 1 < text.length; index += 1) out.add(text.slice(index, index + 2));
  return out;
};
const similarity = (left, right) => {
  const a = bigrams(left), b = bigrams(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram) && !STOP.has(gram)) shared += 1;
  return shared / Math.min(a.size, b.size);
};
const stanceOf = title => {
  const text = norm(title);
  // 「存在」只有在**不是**被否定时才代表肯定：并不存在 / 不存在 → 否定；已经存在 / 真实存在 → 肯定。
  const negative = NEGATIVE.some(word => text.includes(word)) || /不存在|不成立|不可行/.test(text);
  const positive = POSITIVE.some(word => text.includes(word)) || /(?:^|[^不没])(?:已经|已)?存在/.test(text);
  if (positive && !negative) return 'positive';
  if (negative && !positive) return 'negative';
  return 'unknown';
};
const evidenceBrief = item => (Array.isArray(item?.data?.evidence) ? item.data.evidence : []).slice(0, 5).map(row => ({
  kind: String(row?.kind ?? ''),
  ref: String(row?.ref ?? ''),
  quote: String(row?.quote ?? '').slice(0, 120),
}));
const judgmentBrief = item => ({
  id: item.id,
  title: String(item.data?.title ?? '').slice(0, 100),
  status: String(item.data?.status ?? ''),
  statusLabel: STATUS_LABEL[item.data?.status] ?? '状态未记录',
  evidence: evidenceBrief(item),
  uncertainty: String(item.data?.uncertainty ?? '').slice(0, 160) || null,
});

/** 判断卡之间是不是在说**. 同一件事**（用主题词重合近似；阈值偏保守，宁可漏也不硬凑）。 */
export function sameSubject(leftTitle, rightTitle) {
  const shared = similarity(leftTitle, rightTitle);
  return shared >= 0.34;
}

/** 输出与既有判断的矛盾对：双方 id、双方依据、为什么算矛盾。 */
export function findConflicts(judgments) {
  const rows = judgments.filter(item => item?.kind === 'judgment' && !item.archived);
  const conflicts = [];
  for (let left = 0; left < rows.length; left += 1) {
    for (let right = left + 1; right < rows.length; right += 1) {
      const a = rows[left], b = rows[right];
      const projectA = String(a.data?.projectId ?? '');
      const projectB = String(b.data?.projectId ?? '');
      if (projectA && projectB && projectA !== projectB) continue;
      if (!sameSubject(a.data?.title, b.data?.title)) continue;
      const stanceA = stanceOf(a.data?.title), stanceB = stanceOf(b.data?.title);
      const statusA = String(a.data?.status ?? ''), statusB = String(b.data?.status ?? '');
      let reason = null;
      if (stanceA !== 'unknown' && stanceB !== 'unknown' && stanceA !== stanceB) reason = '同一主题上给出了相反结论';
      else if ((statusA === 'overturned' && statusB === 'current') || (statusB === 'overturned' && statusA === 'current')) reason = '旧结论已被推翻，但另一条仍按现行结论在用';
      if (!reason) continue;
      conflicts.push({
        reason,
        a: judgmentBrief(a),
        b: judgmentBrief(b),
      });
    }
  }
  return conflicts;
}

/** 候选判断（还没落库的）也要先和既有判断对一遍：返回会撞上的既有判断与矛盾对。 */
export function checkCandidates(existing, candidates = []) {
  const rows = existing.filter(item => item?.kind === 'judgment' && !item.archived);
  const draftRows = candidates.map((data, index) => ({id: 'candidate-' + (index + 1), kind: 'judgment', data}))
    .filter(item => item.data && typeof item.data.title === 'string' && item.data.title.trim());
  const all = [...rows, ...draftRows];
  return {
    conflicts: findConflicts(all).filter(pair => pair.a.id.startsWith('candidate-') || pair.b.id.startsWith('candidate-')),
    sameSubject: draftRows.map(row => ({
      candidateId: row.id,
      title: String(row.data.title).slice(0, 100),
      matches: rows.filter(item => sameSubject(item.data?.title, row.data.title)).map(judgmentBrief).slice(0, 5),
    })),
    existingCount: rows.length,
  };
}

export function judgmentChecks({store, ctx, projectId, candidates = [], limit = 10} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new DomainError('INVALID', '条数应为 1–20');
  if (!Array.isArray(candidates) || candidates.length > 10) throw new DomainError('INVALID', '候选判断最多 10 条');
  const rows = store.list(ctx, {kind: 'judgment', query: '', includeArchived: false, limit: 500})
    .filter(row => !projectId || row.data?.projectId === projectId);
  const checked = checkCandidates(rows, candidates);
  return {
    existing: rows.sort((left, right) => String(right.at ?? '').localeCompare(String(left.at ?? '')))
      .slice(0, limit).map(judgmentBrief),
    ...checked,
  };
}
