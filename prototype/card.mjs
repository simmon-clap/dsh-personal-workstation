/** 卡片外壳（唯一实现；spec/54 §3.1/§4、spec/56 §1）。
 *
 *  为什么要有它：项目卡、任务卡（看板/行式）、收件箱改动卡原来各写各的外壳 ——
 *  「同一张卡片」这件事只能靠人眼看出来，门禁看不出。这里把**外壳与密度**收成一处：
 *   · 两档密度：`standard`（页面标准档）与 `canvasNode`（画布紧凑变体，登记在 registry.components.card）；
 *   · 外壳属性顺序与类名由本文件统一产出，页面只负责内容块（标题/元信息/动作）；
 *   · 密度标记只有一个来源：别处不得再手写 data-density 字面量（component-signature-audit 规则 8 会红）。
 *
 *  边界：这不是把三页内容揉成一个组件 —— 卡片内容本来就不同（项目/任务/改动）。
 *  统一的是可统一的部分：外壳、密度、标题、元信息行的写法与转义。 */

/** 允许的两档密度（与 spec/registry.json components.card.densities 一一对应）。 */
export const CARD_DENSITIES = Object.freeze(['standard', 'canvasNode']);
export const DENSITY_STANDARD = 'standard';
export const DENSITY_CANVAS = 'canvasNode';

export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));

/** 密度标记：只允许登记过的两档；传错就当场报错，不悄悄降级成默认档。 */
export function cardDensityAttr(density = DENSITY_STANDARD) {
  if (!CARD_DENSITIES.includes(density)) throw Error('未登记的卡片密度：' + density);
  return ' data-density="' + density + '"';
}

const attribute = (name, value) => value === undefined || value === null || value === '' ? '' : ' ' + name + '="' + escapeHtml(String(value)) + '"';

/** 卡片开始标签：统一「外壳类名 → 密度 → 角色/序号 → 业务标识 → 额外属性」的顺序。
 *  @param {object} options
 *  @param {string} [options.tag]  button 或 div（收件箱卡里有嵌套按钮，必须是 div）
 *  @param {string} [options.className] 外壳类名（如 'project surface'）
 *  @param {string} [options.density]  standard / canvasNode
 *  @param {string} [options.role]  role 属性（div 卡用 button）
 *  @param {number|string} [options.tabindex]  tabindex
 *  @param {string} [options.project]  data-project 标识
 *  @param {string} [options.task]  data-task 标识
 *  @param {string} [options.batch]  data-batch 标识
 *  @param {string} [options.extra]  已拼接好的额外属性（调用方保证转义）
 */
export function cardOpen({tag = 'button', className = '', density = DENSITY_STANDARD, role = '', tabindex = '', project = '', task = '', batch = '', extra = ''} = {}) {
  if (!['button', 'div'].includes(tag)) throw Error('卡片外壳只支持 button / div：' + tag);
  return '<' + tag + attribute('class', className) + cardDensityAttr(density)
    + attribute('role', role) + attribute('tabindex', tabindex)
    + attribute('data-project', project) + attribute('data-task', task) + attribute('data-batch', batch)
    + extra + '>';
}
export const cardClose = (tag = 'button') => '</' + tag + '>';

/** 卡片标题：同一种写法（默认 h3），不再各页各写一层。 */
export function cardTitle(text, {tag = 'h3', className = '', style = ''} = {}) {
  return '<' + tag + attribute('class', className) + (style ? ' style="' + style + '"' : '') + '>' + escapeHtml(text) + '</' + tag + '>';
}

/** 元信息行：把非空片段用「 · 」连起来（空片段自动跳过，不留孤零零的分隔符）。 */
export function cardMetaLine(parts, {tag = 'p', className = '', attribute: extra = ''} = {}) {
  const text = parts.filter(part => part !== undefined && part !== null && String(part).trim() !== '').map(part => String(part).trim()).join(' · ');
  return '<' + tag + attribute('class', className) + attribute('data-line', extra) + '>' + text + '</' + tag + '>';
}
