/**
 * 数据调色板（用户 2026-10-13 拍板：逐项目/伙伴配色**算数据**，不算界面配色）。
 *
 * 为什么需要它：项目卡、画布节点、甘特条、路线图会给每个项目/伙伴一个固定色相，
 * 用来在图上区分对象 —— 这是**数据标识**，不是 UI 语义色，所以不能收敛到 VI 的 15 色
 * （收敛会让不同项目共用颜色、辨识度直接掉下去）。
 *
 * 但它也不能散落在模块里当字面值（那就是"没有门禁的债务会自己长"）。做法：
 *   1. 这张表是唯一的定义处，色值取自现行实现的**原值**（零位移）；
 *   2. 门禁按 `spec/registry.json` 的 `dataPalette` 逐条核对：
 *      每个值必须在这里登记、且每个值都必须真的被某个模块引用，多一个少一个都失败。
 *
 * 用法：
 *   · 能写 CSS 的地方（内联 style / style.cssText / SVG 表现属性）直接 `var(--ws-data-*)`；
 *   · 需要真实色值的 JS 分支用 `dataColor('--ws-data-relation-confirmed')`。
 */

/** key → 原值。key 里禁止出现"颜色"以外的含义（色相就是它的全部语义）。 */
export const DATA_COLORS = {
  // 关系三态（已确认 / AI 建议 / 已过时）—— 与 VI 状态符号配套，但仍需各自可区分
  'relation-confirmed': '#9db2cf',
  'relation-suggested': '#a28cc5',
  'relation-stale': '#b6a17c',
  // 画布节点（项目 / 任务 / 知识 / 事务 四类）
  'node-project': '#345074',
  'node-focus': '#417fe8',
  'node-surface': '#f8fbff',
  'node-track': '#e1e8f2',
  'node-line': '#bccde5',
  'node-muted': '#899bb3',
  'node-accent': '#5276a6',
  'node-soft': '#eef3ff',
  'node-frame': '#dde6f2',
  // 甘特/路线图
  'gantt-pending': '#7595c2',
  'gantt-bar': '#739be2',
  'gantt-line': '#dce4ef',
  'gantt-track': '#e8edf5',
  // 项目伙伴配色（project-data.mjs 的 palette）
  'partner-1': '#6488d6', 'partner-1-soft': '#edf2ff',
  'partner-2': '#54a38b', 'partner-2-soft': '#eaf5f0',
  'partner-3': '#9981c3', 'partner-3-soft': '#f2eef9',
  'partner-4': '#bc985d', 'partner-4-soft': '#f8f2e7',
  // 进度条与统计
  'progress-track': '#edf0f5',
  'progress-rest': '#bcc8dc',
  'progress-label': '#596c8b',
  'metric-done': '#4b9b84',
  'metric-open': '#8493a9',
  'metric-muted': '#9aa6b6',
  'metric-value': '#476c9d',
  'form-hint': '#d3ddeb',
  'alert': '#8c3b3b',
};

export const dataVar = name => 'var(--ws-data-' + name + ')';

/** 生成 CSS 变量层（由 build-v7.mjs 写进 src/v7/v7-data.css）。 */
export function dataPaletteCss() {
  const body = Object.entries(DATA_COLORS).map(([name, value]) => `  --ws-data-${name}:${value};`).join('\n');
  return `/* 数据调色板（由 prototype/data-palette.mjs 生成，勿手改）。
   逐项目/伙伴配色是**数据标识**，不是 UI 语义色：值取自现行实现的原值（零位移），
   登记在 spec/registry.json 的 dataPalette，守卫逐条核对。 */
:root{
${body}
}
`;
}

/**
 * 取数据色的**真实色值**（给 SVG 表现属性、canvas 等不支持 var() 的场景）。
 * 浏览器里从根元素读变量；非浏览器（测试沙箱）退化为原值表，保证结构断言照常。
 */
export function dataColor(name, root = (typeof document !== 'undefined' ? document.documentElement : null)) {
  const key = String(name).replace(/^--ws-data-/, '');
  const fallback = DATA_COLORS[key];
  if (fallback === undefined) throw new Error('未登记的数据色：' + name);
  if (!root || typeof getComputedStyle !== 'function') return fallback;
  try {
    const value = getComputedStyle(root).getPropertyValue('--ws-data-' + key).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}
