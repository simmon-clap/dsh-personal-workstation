/** 判断导出（宪章第二条 · F16 / F17）。
 *
 *  验收判据：**收件人无需解释，就能看懂哪条是谁在何时判断、依据是什么**；
 *  并且**剔除项被明示**（分享默认仅自己）。
 *
 *  两个硬规则：
 *  ① 分享边界**默认仅自己** —— 没写 share 的记录一律按「仅自己」处理（宁可少分享）；
 *  ② 文档必须自带来处与时间，且**不依赖插件运行**（纯 Markdown，十年后也读得懂）。
 */

/** 分享边界：只有明确标了 team 的才对外。缺省 = 仅自己。 */
export const isShared = item => item?.data?.share === 'team';

const stateText = status => ({current: '当前有效', checking: '待核对', overturned: '已被推翻'}[status] ?? status ?? '未记录');

/** 作者翻译（2026-10-16 判据 6 验收发现）：原来直接写 `operator:<uuid>` —— 别人看不懂"谁"。
 *  规则：说人话，**绝不把内部编号或 UUID 摆给读者**。 */
export function humanAuthor(author, ownerName = '本工作台的操作者') {
  const raw = String(author ?? '').trim();
  if (!raw) return '未记录';
  if (/^operator:/i.test(raw)) return ownerName;
  if (/^agent:/i.test(raw)) return '工作台的助理（AI）';
  // 裸 UUID 认不出是谁 —— 宁可说"未记录"，也不摆一串编号
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return '未记录';
  return raw;
}

/** 时间翻译：`2026-10-16T07:00:16.852Z` → `2026-10-16 15:00`（读的人不需要看毫秒与时区后缀）。 */
export function humanTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 出处翻译：`art-3dcim-minutes-20261011` 这种内部编号对读者毫无意义。
 *  `resolve(ref)` 由调用方提供（它才拿得到对象标题）；解析不到就说"这条判断引用的资料"，
 *  **不退回裸 id** —— 把编号摆给读者等于什么都没说。 */
export function humanRef(ref, resolve, kind = null) {
  const raw = String(ref ?? '').trim();
  if (!raw) return '未记录';
  // 形如 `文件@120-180` 的**引用锚点**：规范（03 §10）里"录音 → 文件 + 时间区间（秒）"，
  // 也就是"哪一段"本身就是锚点的一部分。**不能因为有了解析出来的标题就把范围丢掉** ——
  // 判据 3 要的正是"追回**那一段**"；丢了范围，读者只看到"某份录音"，还是追不回具体位置。
  // （2026-10-16 实测：导出文档里本来是"（第 120–180 段）"，被标题覆盖掉了，就是这里。）
  const ranged = /^(.+?)@(\d+)-(\d+)$/.exec(raw);
  const where = ranged ? '（' + (kind === 'audio' ? '第 ' + ranged[2] + '–' + ranged[3] + ' 秒' : '第 ' + ranged[2] + '–' + ranged[3] + ' 段') + '）' : '';
  const label = typeof resolve === 'function' ? resolve(raw) : null;
  if (label) return String(label) + where;
  if (ranged) return '这条判断引用的资料' + where;
  return '这条判断引用的资料';
}
const sourceKindText = kind => ({message: '会话原文', file: '文件', audio: '录音', web: '网页', note: '你自己的口述'}[kind] ?? '未记录');

/** 预览：导出前必须能看到"将分享 N 条 · 剔除 M 条仅自己"。 */
export function exportPreview(items) {
  const shared = items.filter(isShared);
  return {shared: shared.length, excluded: items.length - shared.length, total: items.length};
}

/** 生成可独立阅读的 Markdown。只包含标了「可以给同事看」的判断。 */
export function judgmentDocument(items, {at = new Date().toISOString(), owner = '本工作台', resolve = null, ownerName = '本工作台的操作者'} = {}) {
  const shared = items.filter(isShared);
  const {excluded} = exportPreview(items);
  const lines = [
    '# 判断记录',
    '',
    `这份文档由${owner}导出，导出时间 ${humanTime(at)}。`,
    '',
    '每一条都写了：**谁在什么时候判断、依据是什么**。依据里的「出处」指回当时真正读到的东西'
      + '（会话原文、文件、录音、网页或口述），不是转述。',
    '',
    excluded
      ? `**已剔除 ${excluded} 条标为「仅自己」的判断**，它们不在本文档里。`
      : '本次没有剔除项（没有被标为「仅自己」的判断）。',
    '',
    `共 ${shared.length} 条。`,
    '',
  ];
  if (!shared.length) {
    lines.push('（没有可以分享的判断。把某条判断标为「可以给同事看」后，它才会出现在这里。）', '');
    return lines.join('\n');
  }
  shared.forEach((item, index) => {
    const d = item.data ?? {};
    lines.push(`## ${index + 1}. ${d.title ?? item.id}`, '');
    lines.push(`- 谁在何时判断：${humanAuthor(item.author, ownerName)}${d.validFrom ? `，什么时候成立 ${d.validFrom}` : ''}${item.at ? `，记录时间 ${humanTime(item.at)}` : ''}`);
    lines.push(`- 状态：${stateText(d.status)}`);
    const evidence = Array.isArray(d.evidence) ? d.evidence : [];
    lines.push(`- 依据：${evidence.length ? `${evidence.length} 条` : '缺'}`);
    evidence.forEach((one, i) => {
      const verified = one.verified === true ? '，已经过第三方验证' : one.verified === false ? '，尚未经过第三方验证' : '';
      lines.push(`  ${i + 1}. [${sourceKindText(one.kind)}] ${one.quote ?? '（无原文）'}（出处：${humanRef(one.ref, resolve, one.kind)}${verified}）`);
    });
    lines.push(`- 不确定性：${d.uncertainty ? d.uncertainty : '未标不确定性'}`);
    if (d.reviewBy) lines.push(`- 何时该复核：${d.reviewBy}`);
    if (d.status === 'overturned' && d.overturnedBy) {
      const by = d.overturnedBy;
      lines.push(`- 推翻依据：${by.reason ?? '未记录'}${by.ref ? `（出处：${humanRef(by.ref, resolve, 'note')}）` : ''}${by.at ? `，推翻时间 ${humanTime(by.at)}` : ''}`);
      lines.push('- 说明：这条判断已经被推翻，**原依据仍然保留在上面**，不抹掉当时为什么这么想。');
    }
    lines.push('');
  });
  return lines.join('\n');
}
