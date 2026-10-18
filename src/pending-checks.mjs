import {DomainError} from './store.mjs';

/** W3-C 主动追问：把「待核对 / 不确定性」变成**能执行的一问**（26 §6 能力③）。
 *
 *  一条待核对必须回答四件事，缺一条用户就没法行动：
 *    问谁（有记录就用记录里的负责人/合作方；没有就如实写还没记录）
 *    问什么（判断里写下的不确定性）
 *    什么算完成（复核日期，或"找到一条能确认或推翻它的原始出处"）
 *    为什么现在（还在待核对 / 写着不确定却已当现行结论在用）
 *  这些项来自判断本身，不新造数据；工作台收件箱把它们列出来，Agent 也可以在对话里主动问。
 */
const clip = (value, max) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > max ? text.slice(0, max) + '…' : text;
};
const day = value => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '');

const personName = (store, ctx, id) => {
  if (!id) return null;
  try {
    const item = store.get(ctx, id);
    return item && !item.archived ? clip(item.data?.title, 60) : null;
  } catch {
    return null;
  }
};

export function buildPendingChecks({store, ctx, now = new Date(), limit = 5} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new DomainError('INVALID', '条数应为 1–20');
  const rows = store.list(ctx, {kind: 'judgment', query: '', includeArchived: false, limit: 500})
    .filter(row => !row.archived)
    .filter(row => {
      const status = String(row.data?.status ?? '');
      return status === 'checking' || Boolean(String(row.data?.uncertainty ?? '').trim());
    });
  const order = row => {
    const status = String(row.data?.status ?? '');
    const review = day(row.data?.reviewBy);
    const rank = status === 'checking' ? 0 : review && review <= day(now.toISOString()) ? 1 : 2;
    return [rank, review || '9999-99-99'];
  };
  return rows
    .sort((left, right) => {
      const [rankA, dateA] = order(left), [rankB, dateB] = order(right);
      return rankA - rankB || dateA.localeCompare(dateB);
    })
    .slice(0, limit)
    .map(row => {
      const data = row.data ?? {};
      const project = data.projectId ? store.get(ctx, data.projectId) : null;
      const projectData = project && !project.archived ? project.data ?? {} : {};
      const ownerId = data.ownerId || projectData.ownerId;
      const partnerId = projectData.partnerId;
      const askWho = personName(store, ctx, ownerId);
      const partner = personName(store, ctx, partnerId);
      const reviewBy = day(data.reviewBy);
      const evidence = Array.isArray(data.evidence) ? data.evidence[0] : null;
      const status = String(data.status ?? '');
      return {
        judgmentId: row.id,
        title: clip(data.title, 100),
        projectId: project ? project.id : null,
        projectTitle: project ? clip(projectData.title, 80) : null,
        askWho: askWho ?? null,
        askWhoLabel: askWho ? '问 ' + askWho : (partner ? '先问 ' + partner + '，还是你直接核？' : '还没记录找谁核'),
        askWhat: clip(data.uncertainty, 200) || '这条判断的依据是否仍然成立？',
        whatCountsAsDone: reviewBy
          ? '在 ' + reviewBy + ' 前找到一条能确认或推翻它的原始出处'
          : '找到一条能确认或推翻它的原始出处',
        whyNow: status === 'checking' ? '这条判断还标着「待核对」' : '它写着不确定性，却已经按现行结论在用',
        reviewBy: reviewBy || null,
        evidenceRef: evidence && typeof evidence.ref === 'string' ? clip(evidence.ref, 200) : null,
      };
    });
}
