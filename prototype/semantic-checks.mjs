#!/usr/bin/env node
/** 语义门禁判据（17 号约束 §3）——**纯函数**，不碰浏览器。
 *
 *  为什么单独一层：
 *    · `semantic-gates.mjs` 负责在正在运行的真实实例上量 DOM，量完把数据喂给这里；
 *    · 这里只做判定，所以可以**离线自检（canary）**：给一份「干净的测量数据」，
 *      人为注入一条违规，断言对应判据真的红 —— 这是 17 §3.11「每个门禁有 canary」的落法。
 *    · 以后改判据、加判据，都先在这里补 canary，再改驱动脚本。
 *
 *  判据来源：spec/17-产品级交付约束-v1.0.md §3（13 项语义判据的最低配置）。
 *  已机械化：S1/S2/S3/S4/S5/S6/S7/S8/S10/S12（见下）；S9 真实用户路径、S13 助理级 C7 是人工验收（W5/W3）。
 *
 *  用法：
 *    import {CHECKS, runChecks, cleanFixture, canaryReport} from './semantic-checks.mjs';
 */

const num = value => Number.parseFloat(value) || 0;
const push = (list, where, what, count = 1, extra = {}) => list.push({where, what, count, ...extra});

/** S1 · 页面标题层级（17 §3.1）：
 *  h1/h2/h3 对应 22/18/15 三档；卡片标题不得比栏目标题粗；无 700。 */
function S1(data, out) {
  const title = data.pageTitle;
  if (title && title.tag !== 'H1') push(out, '全站', '页面标题不是 h1（当前 <' + title.tag.toLowerCase() + '> ' + title.text + ' ' + title.size + '）', 1);
  if (title && Math.abs(num(title.size) - 22) > 0.01) push(out, '全站', '页面标题字号不是 22px', 1, {size: title.size});
  for (const [name, m] of Object.entries(data.views)) {
    const heads = m.headings ?? [];
    const expected = {H1: 22, H2: 18, H3: 15};
    for (const tag of ['H1', 'H2', 'H3']) {
      const offenders = heads.filter(h => h.tag === tag && Math.abs(num(h.size) - expected[tag]) > 0.01);
      if (offenders.length) push(out, name, tag + ' 应为 ' + expected[tag] + 'px（实际 ' + [...new Set(offenders.map(h => h.size))].join('/') + '）', offenders.length, {sample: offenders[0]?.text});
    }
    const any700 = (m.weightViolations ?? []).length;
    if (any700) push(out, name, '页面存在 700 字重文本（非仅标题）', any700);
    // 17 C5「正文 14/22」的机械兜底：11px 只许时间/坐标，长段 11px 文本就是正文被缩印。
    if ((m.body11 ?? 0) > 0) push(out, name, '11px 当正文（>30 字的连续文本）', m.body11);
    const section = heads.filter(h => h.tag === 'H2').map(h => num(h.weight));
    const cards = heads.filter(h => h.tag === 'H3');
    if (section.length && cards.length) {
      const minSection = Math.min(...section);
      const bolder = cards.filter(h => num(h.weight) > minSection).length;
      if (bolder) push(out, name, '卡片标题比栏目标题粗', bolder, {section: minSection});
    }
  }
}

/** S2 · 每页主色按钮 ≤1；同一动作入口唯一（17 §3.2）。 */
function S2(data, out) {
  const mismatch = new Set();
  for (const [name, m] of Object.entries(data.views)) {
    const primaries = m.primaries ?? [];
    if (primaries.length > 1) push(out, name, '主色按钮超过 1 个', primaries.length - 1, {sample: primaries.map(b => b.text).slice(0, 4)});
    for (const item of m.primaryClassMismatch ?? []) mismatch.add(item.id + '|' + item.text + '|' + item.bg);
    const duplicateNew = name === 'projects' && m.newEntrances?.topbar
      && (m.newEntrances.inView ?? []).some(b => /新建项目/.test(b.text));
    if (duplicateNew) push(out, name, '同一「新建项目」动作有两个入口（顶栏 + 页内）', 1, {sample: m.newEntrances.inView?.map(b => b.text)});
  }
  if (mismatch.size) push(out, '全站', '声明 primary 但渲染不是主色（类名与渲染不一致）', mismatch.size, {sample: [...mismatch].slice(0, 3)});
}

/** S3 · 设置页首屏 ≤1 屏；首屏 ≥1 个与用户目标相关的可点内容；无互相矛盾的同一事实（17 §3.3）。 */
function S3(data, out) {
  const s = data.settings;
  if (!s?.opened) { push(out, '设置', '设置弹窗没有打开（无法判定，不等于通过）', 1); return; }
  const ratio = s.drawer.ch ? s.drawer.sh / s.drawer.ch : 0;
  if (ratio > 1.05) push(out, '设置', '内容高度超过 1 屏（scrollHeight/clientHeight=' + ratio.toFixed(2) + '）', 1, {value: ratio});
  if ((s.firstScreenContent ?? []).length === 0) push(out, '设置', '首屏没有与用户目标相关的可点内容（只有底栏/关闭）', 1);
  if ((s.contradictions?.pairs ?? 0) > 0) push(out, '设置', '同一页出现互相矛盾的「定时」说法', s.contradictions.pairs, {negatives: s.contradictions.negs, positives: s.contradictions.poss});
}

/** S4 · 空数据不画成数据（17 §3.4）：0/0 不画环、不画满宽条。 */
function S4(data, out) {
  for (const [name, m] of Object.entries(data.views)) {
    const emptyRings = (m.rings ?? []).filter(r => /^[—–-]$/.test(String(r.text).trim()) || /^0%$/.test(String(r.text).trim()) || /^0\s*\//.test(String(r.text).trim())).length;
    if (emptyRings) push(out, name, '空数据仍画出进度环', emptyRings);
    const fullBars = (m.meters ?? []).filter(x => x.total === 0 && x.trackRatio >= 0.6).length;
    if (fullBars) push(out, name, '0/0 仍画满宽进度条', fullBars);
  }
}

/** S5 · 画布默认可读（17 §3.5）：默认缩放 ≥60%，或屏幕像素 ≥12；<60% 只显示名称+类型。 */
function S5(data, out) {
  const c = data.canvas;
  if (!c?.opened) { push(out, '画布', '画布没有打开（无法判定，不等于通过）', 1); return; }
  const zoom = num(c.zoom);
  if (zoom < 0.6) {
    push(out, '画布', '默认缩放 ' + Math.round(zoom * 100) + '%（<60%）', 1, {value: zoom});
    const tiny = (c.texts ?? []).filter(t => num(t.effective) < 12).length;
    if (tiny) push(out, '画布', '<60% 时文字屏幕像素 <12px', tiny, {sample: (c.texts ?? []).filter(t => num(t.effective) < 12).slice(0, 3).map(t => t.text + ' ' + t.effective.toFixed(1) + 'px')});
    const counts = (c.texts ?? []).filter(t => /\d+\s*\/\s*\d+\s*项/.test(t.text)).length;
    if (counts) push(out, '画布', '<60% 仍显示计数等细节（应只显示名称+类型）', counts, {sample: (c.texts ?? []).find(t => /\d+\s*\/\s*\d+\s*项/.test(t.text))?.text});
  }
}

/** S6 · 组件唯一（17 §3.6）：按钮三档内、标签一种、输入一种、空态一种；图标 16/20/24、线宽 1.6。 */
function S6(data, out) {
  const views = Object.entries(data.views);
  const heights = new Set();
  for (const [, m] of views) for (const b of m.buttons ?? []) heights.add(Math.round(num(b.height)));
  const distinctHeights = [...heights].filter(h => h > 0).sort((a, b) => a - b);
  if (distinctHeights.length > 3) push(out, '全站', '按钮组件高度超过三档', distinctHeights.length - 3, {heights: distinctHeights});
  const chipSigs = new Set();
  const inputSigs = new Set();
  const emptySigs = new Set();
  const iconBad = new Set();
  const strokeBad = new Set();
  for (const [name, m] of views) {
    // 标签一种：只看 .chip 这一套 pill 的**视觉签名**（字号/高度/圆角/边框/内边距）；
    // .tagline 是纯文本元信息、.statusdot 是状态色点，不是"标签组件"，不参与这一条。
    for (const chip of m.chips ?? []) {
      if (chip.family !== 'chip') continue;
      chipSigs.add([chip.size, chip.height, chip.radius, chip.bw, chip.pad].join('|'));
    }
    for (const input of m.inputs ?? []) inputSigs.add(input.sig);
    for (const empty of m.emptyStates ?? []) emptySigs.add(empty.signature);
    for (const icon of m.icons ?? []) {
      const size = Math.round(num(icon.w));
      if (![16, 20, 24].includes(size)) iconBad.add(size + '|' + icon.class);
      const stroke = num(icon.stroke);
      if (Math.abs(stroke - 1.6) > 0.011) strokeBad.add(stroke + '|' + icon.class);
    }
  }
  if (chipSigs.size > 1) push(out, '全站', '标签不止一种长相', chipSigs.size - 1, {signatures: [...chipSigs]});
  if (inputSigs.size > 1) push(out, '全站', '输入控件不止一套', inputSigs.size - 1, {samples: [...inputSigs].slice(0, 4)});
  if (emptySigs.size > 1) push(out, '全站', '空态不止一套', emptySigs.size - 1, {signatures: [...emptySigs]});
  if (iconBad.size) push(out, '全站', '图标尺寸不在 16/20/24', iconBad.size, {sizes: [...new Set([...iconBad].map(x => Number(x.split('|')[0])))]});
  if (strokeBad.size) push(out, '全站', '图标线宽不是 1.6', strokeBad.size, {widths: [...new Set([...strokeBad].map(x => Number(x.split('|')[0])))]});
  const empties = views.flatMap(([name, m]) => (m.emptyStates ?? []).map(e => ({name, ...e})));
  const noNext = empties.filter(e => !e.hasButton).length;
  if (noNext) push(out, '全站', '空态没有下一步按钮', noNext, {sample: empties.filter(e => !e.hasButton).slice(0, 2).map(e => e.name + ':' + String(e.text).slice(0, 12))});
}

/** S7 · 弹窗五条 + 危险操作分离（17 §3.7）。
 *  五条=居中/Escape/焦点恢复/背景不可操作/未保存保护；危险操作必须与主操作分离。 */
function S7(data, out) {
  const s = data.settings ?? {};
  const rules = s.rules ?? {};
  if (rules.centered === false) push(out, '弹窗', '没有居中', 1, {offset: rules.centeredOffset});
  if (rules.escapeCloses === false) push(out, '弹窗', 'Escape 关不掉', 1);
  if (rules.focusRestored === false) push(out, '弹窗', '关闭后焦点没有回到打开处', 1, {active: rules.activeAfterClose});
  if (rules.backgroundInert === false) push(out, '弹窗', '弹窗打开时背景仍可操作', 1, {free: rules.backgroundFree});
  const e = data.editor ?? {};
  if (e.unsavedProtected === false) push(out, '编辑弹窗', '有未保存内容时 Escape 直接关闭（无确认/草稿）', 1);
  const gap = typeof e.dangerGap === 'number' ? e.dangerGap : null;
  if (gap !== null && gap < 24) push(out, '编辑弹窗', '危险操作紧邻主操作（间距 ' + Math.round(gap) + 'px）', 1, {value: gap});
}

/** S8 · 移动端（17 §3.8）：导航单行（或收进更多）；首屏至少 1 条可操作内容；粘性底栏不盖决定字段。 */
function S8(data, out) {
  const m = data.mobile;
  if (!m) { push(out, '移动端', '没有量到移动端（无法判定，不等于通过）', 1); return; }
  if ((m.navRows ?? 0) > 1) push(out, '移动端', '导航折成 ' + m.navRows + ' 行（高 ' + Math.round(m.navH) + 'px）', 1, {value: m.navRows});
  for (const [name, view] of Object.entries(m.views ?? {})) {
    if ((view.actionableFirstScreen ?? 0) === 0) push(out, '移动端 · ' + name, '首屏没有可操作内容', 1);
    if (name === 'tasks' && (view.visibleTasks ?? null) === 0) push(out, '移动端 · ' + name, '首屏看不到一条任务', 1, {firstTaskTop: view.firstTaskTop});
    if (view.metricsH > 0.4 * (m.vh || 844) && view.metricsShowZero) push(out, '移动端 · ' + name, '空指标占掉首屏 ' + Math.round(view.metricsH) + 'px', 1);
  }
  const d = m.detail ?? {};
  if ((d.overlaps ?? []).length) push(out, '移动端 · 任务详情', '粘性底栏盖住决定字段', d.overlaps.length, {fields: d.overlaps});
  if ((d.firstScreenVisible ?? null) === 0) push(out, '移动端 · 任务详情', '首屏看不到任何决定字段（负责人/业务状态/截止/执行端）', 1, {footerH: d.footerH});
  if ((d.hiddenAtBottom ?? []).length) push(out, '移动端 · 任务详情', '滚到底仍有内容被底栏挡住', d.hiddenAtBottom.length, {fields: d.hiddenAtBottom});
}

/** IM/飞书四层健康的四条文案判据（单一来源；semantic-gates 与界面测试共用）。 */
export const IM_HEALTH_PATTERNS = {
  '加载': /插件[^。]{0,24}(加载|没加载|未加载|异常|不兼容)/,
  '连接': /渠道[^。]{0,24}(连接|未连接|断开|已连接)/,
  'cwd': /(会话目录|cwd)[^。]{0,28}(工作区|指向|未指向)/,
  '发送': /发送[^。]{0,20}(代码|实现|未实现|可用)/
};

/** S10 · 跨插件健康四行（17 §3.10）：IM/飞书的「加载/连接/cwd/发送」四行状态可见。 */
function S10(data, out) {
  const health = data.settings?.health ?? {missing: ['加载', '连接', 'cwd', '发送']};
  if ((health.missing ?? []).length) push(out, '设置 · IM/飞书', '四层健康缺少 ' + health.missing.join('、'), health.missing.length, {missing: health.missing});
}

/** S12 · 文案（17 §3.12）：解释性/实现性文案 0 处。 */
function S12(data, out) {
  for (const [name, m] of Object.entries(data.views)) {
    const hits = m.wording ?? [];
    if (hits.length) push(out, name, '解释性/实现性文案', hits.length, {sample: hits.slice(0, 3).map(h => h.phrase + ' «' + h.quote + '»')});
  }
  const subtitleHits = data.subtitleWording ?? [];
  if (subtitleHits.length) push(out, '顶栏', '解释性/实现性文案', subtitleHits.length, {sample: subtitleHits.map(h => h.phrase)});
  // W2-3 页面身份：七页不能共用同一句副标题（46 §1.1「7 页同一句」）。
  const subtitles = Object.values(data.views ?? {}).map(v => v?.subtitle).filter(Boolean);
  const unique = new Set(subtitles);
  if (subtitles.length > 1 && unique.size < subtitles.length) push(out, '顶栏', '全站同一句副标题（页面身份缺失）', subtitles.length - unique.size, {sample: [...unique].slice(0, 2)});
}

/** S14 · 画布层级与分类（spec/54 §4 / spec/56 §8.1）。
 *  量的是**默认进画布时**用户看到的东西，不是函数返回值：
 *   · 默认范围是结构态（D8=全部机构），按关系角色分列；
 *   · 未分类/未归属如实成列，不藏、不猜；
 *   · 结构层只有机构与（未归属）项目；资料/议题/判断/事务不进主层；
 *   · 默认缩放 ≥60% 或屏幕文字 ≥12px（VI §9 / S5 同一口径）；
 *   · 角色必须有颜色+形状+名称三重编码（颜色不得单独承担区分）；
 *   · 项目视觉面积 > 任务（VI §9「节点大小=层级」）。 */
function S14(data, out) {
  const c = data.canvasStructure;
  if (!c?.opened) { push(out, '画布', '没有量到结构态（无法判定，不等于通过）', 1); return; }
  if (c.mode !== 'structure') push(out, '画布', '默认范围不是「按分类」结构态（D8 要求默认全部机构）', 1, {mode: c.mode});
  const buckets = Array.isArray(c.buckets) ? c.buckets : [];
  if (!buckets.length) push(out, '画布', '结构态没有分出任何分类列', 1);
  for (const bucket of buckets) {
    if (bucket.kind === 'role' && bucket.hasShape === false) push(out, '画布', '分类「' + (bucket.label || bucket.key) + '」只有颜色没有形状/名称（颜色单独承担区分）', 1);
  }
  if ((c.unclassifiedCount ?? 0) > 0 && !buckets.some(b => b.kind === 'unclassified')) push(out, '画布', '有 ' + c.unclassifiedCount + ' 个未分类机构却没有「未分类」列（把未知藏起来了）', 1);
  if ((c.unassignedCount ?? 0) > 0 && !buckets.some(b => b.kind === 'unassigned')) push(out, '画布', '有 ' + c.unassignedCount + ' 个未归属项目却没有「未归属」列', 1);
  const stray = (c.mainKinds ?? []).filter(kind => !['organization', 'project'].includes(kind));
  if (stray.length) push(out, '画布', '结构层混入非结构对象：' + [...new Set(stray)].join('、'), stray.length);
  if (Number.isFinite(c.zoom) && c.zoom < 0.6 && !(Number.isFinite(c.minTextEffective) && c.minTextEffective >= 12)) {
    push(out, '画布', '默认缩放 ' + Math.round(c.zoom * 100) + '%、屏幕文字最小 ' + (c.minTextEffective ?? 0).toFixed(1) + 'px（需 ≥60% 或 ≥12px）', 1, {zoom: c.zoom});
  }
  if (Number.isFinite(c.projectArea) && Number.isFinite(c.taskArea) && c.projectArea <= c.taskArea) {
    push(out, '画布', '项目卡面积不大于任务卡（' + Math.round(c.projectArea) + ' ≤ ' + Math.round(c.taskArea) + 'px²）', 1);
  }
}

/** S15 · 四表面一致（spec/54 §4 / spec/56 §8.2）：项目 / 任务 / 收件箱 / 画布 用同一套组件实现与两档密度。
 *  浏览器侧能直接量到的四件事：详情弹窗只有一个宽度且居中、空态只有一种结构、卡片密度只允许登记过的两档、
 *  每页只有一个「筛选」控件。 */
function S15(data, out) {
  const s = data.surfaces;
  if (!s?.measured) { push(out, '四表面', '没有量到四表面（无法判定，不等于通过）', 1); return; }
  for (const dialog of s.dialogs ?? []) {
    if (Number.isFinite(dialog.width) && Math.abs(dialog.width - 760) > 1) push(out, dialog.surface || '详情弹窗', '详情弹窗宽度不是 760（实际 ' + Math.round(dialog.width) + 'px）', 1, {value: dialog.width});
    if (dialog.centered === false) push(out, dialog.surface || '详情弹窗', '详情弹窗没有居中', 1);
  }
  const signatures = [...new Set((s.emptyStates ?? []).map(item => item.signature))];
  if (signatures.length > 1) push(out, '四表面', '空态不止一种结构：' + signatures.join(' / '), signatures.length - 1, {signatures});
  const allowed = new Set(['standard', 'canvasNode']);
  const densities = [...new Set((s.cardDensities ?? []).filter(Boolean))];
  for (const density of densities) if (!allowed.has(density)) push(out, '四表面', '出现未登记的卡片密度：' + density, 1);
  for (const [name, count] of Object.entries(s.filterToggles ?? {})) {
    if (count > 1) push(out, name, '同一页出现 ' + count + ' 个「筛选」控件（应只有一个）', count - 1);
  }
}

export const CHECKS = [
  {id: 'S1', title: '页面标题层级', ref: '17 §3.1', run: S1},
  {id: 'S2', title: '主色主动作 / 入口唯一', ref: '17 §3.2', run: S2},
  {id: 'S3', title: '设置页首屏与矛盾事实', ref: '17 §3.3', run: S3},
  {id: 'S4', title: '空数据不画成数据', ref: '17 §3.4', run: S4},
  {id: 'S5', title: '画布默认可读', ref: '17 §3.5', run: S5},
  {id: 'S6', title: '组件唯一 / 图标在册', ref: '17 §3.6', run: S6},
  {id: 'S7', title: '弹窗五条 + 危险分离', ref: '17 §3.7', run: S7},
  {id: 'S8', title: '移动端首屏与底栏', ref: '17 §3.8', run: S8},
  {id: 'S10', title: '跨插件健康四行', ref: '17 §3.10', run: S10},
  {id: 'S12', title: '解释性文案 0 处', ref: '17 §3.12', run: S12},
  {id: 'S14', title: '画布层级与分类', ref: 'spec/54 §4 · spec/56 §8.1', run: S14},
  {id: 'S15', title: '四表面组件一致', ref: 'spec/54 §4 · spec/56 §8.2', run: S15}
];

/** 跑全部判据。返回 [{id,title,ref,violations,count,fail}]。 */
export function runChecks(data) {
  return CHECKS.map(check => {
    const violations = [];
    check.run(data, violations);
    const count = violations.reduce((sum, v) => sum + (Number.isFinite(v.count) ? v.count : 1), 0);
    return {id: check.id, title: check.title, ref: check.ref, violations, count, fail: count > 0};
  });
}

/* ────────────────────────── canary 夹具 ────────────────────────── */

const cleanHeading = (tag, size, weight, text) => ({tag, text, size: size + 'px', weight: String(weight), class: ''});

/** 一份「完全干净」的测量数据：所有判据都应 0 违规。 */
export function cleanFixture() {
  const view = name => ({
    view: name,
    text: '',
    headings: [cleanHeading('H1', 22, 600, '页面标题'), cleanHeading('H2', 18, 600, '模块标题'), cleanHeading('H3', 15, 550, '卡片标题')],
    weightViolations: [],
    primaries: [{tag: 'BUTTON', text: '新建', bg: 'rgb(49, 94, 208)'}],
    primaryClassMismatch: [],
    newEntrances: {duplicate: false, inView: []},
    rings: [], meters: [],
    chips: [{family: 'chip', text: '标签', size: '12px', height: 40, radius: '999px', bw: '1px', pad: '8px 12px'}],
    inputs: [{sig: 'input|text|36|8|1|white', tag: 'INPUT', type: 'text'}],
    icons: [{w: '20', h: '20', stroke: '1.6', class: 'icon'}, {w: '16', h: '16', stroke: '1.6', class: 'icon'}],
    emptyStates: [{signature: 'img+title+button', hasImg: true, hasHeading: true, hasButton: true, text: '空'}],
    buttons: [{height: 32, text: 'a'}, {height: 36, text: 'b'}, {height: 40, text: 'c'}],
    wording: [], overflow: 0
  });
  const views = {};
  for (const name of ['home', 'inbox', 'space', 'projects', 'tasks', 'knowledge', 'personal']) views[name] = view(name);
  const mobileViews = {};
  for (const name of ['home', 'tasks', 'inbox', 'knowledge']) mobileViews[name] = {actionableFirstScreen: 2, visibleTasks: name === 'tasks' ? 1 : null, metricsH: 80, metricsShowZero: false, firstTaskTop: 200};
  return {
    views,
    pageTitle: {tag: 'H1', text: '工作台', size: '22px', weight: '600'},
    settings: {
      opened: true,
      dialog: {w: 760, h: 827, viewport: {w: 1440, h: 940}},
      drawer: {sh: 800, ch: 825},
      firstScreenContent: [{text: '选择文件夹', top: 200}],
      footerActions: [{text: '保存'}],
      contradictions: {pairs: 0, negs: [], poss: []},
      health: {missing: []},
      rules: {centered: true, escapeCloses: true, focusRestored: true, backgroundInert: true}
    },
    editor: {unsavedProtected: true, dangerGap: 40},
    canvas: {opened: true, zoom: 0.8, texts: [{text: '项目', effective: 10.4}, {text: '会议纪要', effective: 10.4}]},
    mobile: {navRows: 1, navH: 56, vh: 844, views: mobileViews, detail: {overlaps: [], firstScreenVisible: 4, hiddenAtBottom: [], paddingBottom: 140, footerH: 120}},
    subtitleWording: [],
    // S14：默认进画布看到的（结构态、两列、三重编码、缩放与层级尺寸）
    canvasStructure: {
      opened: true,
      mode: 'structure',
      buckets: [
        {key: '客户', label: '客户', kind: 'role', count: 2, hasShape: true},
        {key: 'unassigned', label: '未归属', kind: 'unassigned', count: 1, hasShape: true}
      ],
      mainKinds: ['organization', 'project'],
      unclassifiedCount: 0,
      unassignedCount: 1,
      zoom: 0.8,
      minTextEffective: 10.4,
      projectArea: 260 * 110,
      taskArea: 176 * 72
    },
    // S15：四表面组件签名
    surfaces: {
      measured: true,
      dialogs: [{surface: 'projects', width: 760, centered: true}, {surface: 'tasks', width: 760, centered: true}, {surface: 'inbox', width: 760, centered: true}],
      emptyStates: [{surface: 'projects', signature: 'img+h3+p+button'}, {surface: 'tasks', signature: 'img+h3+p+button'}, {surface: 'inbox', signature: 'img+h3+p+button'}],
      cardDensities: ['standard', 'canvasNode'],
      filterToggles: {projects: 1, tasks: 1, inbox: 1}
    }
  };
}

/** 每条判据的 canary：在干净夹具上注入一处违规，断言对应判据真的红。 */
export const CANARIES = [
  {id: 'S1', why: 'h2 改成 15px + 700', inject: d => { d.views.home.headings.push(cleanHeading('H2', 15, 700, '坏标题')); d.views.home.weightViolations.push({text: '坏标题'}); }},
  {id: 'S2', why: '同页再加一个主色按钮 + 重复新建入口', inject: d => { d.views.projects.primaries.push({tag: 'BUTTON', text: '另一个主色'}); d.views.projects.newEntrances = {duplicate: true, inView: [{text: '新建项目'}]}; }},
  {id: 'S3', why: '设置内容变 3.4 屏 + 首屏无内容动作 + 定时矛盾', inject: d => { d.settings.drawer = {sh: 2809, ch: 825}; d.settings.firstScreenContent = []; d.settings.contradictions = {pairs: 2, negs: ['定时 未接入'], poss: ['已在定时运行']}; }},
  {id: 'S4', why: '空数据画环 + 0/0 画满宽条', inject: d => { d.views.home.rings.push({text: '—'}); d.views.home.meters.push({total: 0, trackRatio: 1}); }},
  {id: 'S5', why: '画布默认 44% 且文字 5.7px、还显示计数', inject: d => { d.canvas = {opened: true, zoom: 0.44, texts: [{text: '项目 0/0 项 · 复盘', effective: 5.72}]}; }},
  {id: 'S6', why: '按钮 6 种高度 + 4 套标签 + 2 套输入 + 17px 图标 + 线宽 1.65 + 空态两种', inject: d => { for (const h of [39, 29, 42, 26]) d.views.home.buttons.push({height: h}); d.views.home.chips.push({family: 'chip', size: '11px', height: 28, radius: '0px', bw: '0px', pad: '0px'}); d.views.home.inputs.push({sig: 'input|search|41|0|2|white'}); d.views.home.icons.push({w: '17', h: '17', stroke: '1.65', class: 'icon'}); d.views.home.emptyStates.push({signature: 'text-only', hasImg: false, hasHeading: false, hasButton: false, text: '当前没有任务'}); }},
  {id: 'S7', why: '弹窗不居中 + Escape 关不掉 + 焦点不回 + 背景可操作 + 未保存直接关 + 危险按钮相邻', inject: d => { d.settings.rules = {centered: false, escapeCloses: false, focusRestored: false, backgroundInert: false, activeAfterClose: 'BODY'}; d.editor = {unsavedProtected: false, dangerGap: 4}; }},
  {id: 'S8', why: '导航两行 + 任务首屏 0 条 + 空指标 462px + 底栏盖字段', inject: d => { d.mobile.navRows = 2; d.mobile.navH = 133; d.mobile.views.tasks.actionableFirstScreen = 0; d.mobile.views.tasks.visibleTasks = 0; d.mobile.views.tasks.metricsH = 462; d.mobile.views.tasks.metricsShowZero = true; d.mobile.detail = {overlaps: ['负责人', '业务状态', '截止'], firstScreenVisible: 0, hiddenAtBottom: ['负责人', '业务状态'], paddingBottom: 0, footerH: 122}; }},
  {id: 'S10', why: '设置页只有「飞书 未接上 未配置」，四层一行都没有', inject: d => { d.settings.health = {missing: ['加载', '连接', 'cwd', '发送']}; }},
  {id: 'S12', why: '解释性文案泄漏 + 七页同一句副标题', inject: d => { d.views.inbox.wording.push({phrase: '最近加载', quote: '来源与项目筛选只作用于本页最近加载的 50 条'}); d.subtitleWording.push({phrase: '总览提示'}); d.views.home.subtitle = d.views.projects.subtitle = '同一句占位提示'; }},
  {id: 'S14', why: '默认回到关系态 + 只有颜色没有形状 + 未分类被藏起来 + 结构层混入资料 + 44% 且文字 5.7px + 任务卡比项目卡大', inject: d => {
    d.canvasStructure = {...d.canvasStructure, mode: 'all', buckets: [{key: '客户', label: '客户', kind: 'role', count: 2, hasShape: false}], mainKinds: ['organization', 'project', 'artifact'], unclassifiedCount: 3, unassignedCount: 0, zoom: 0.44, minTextEffective: 5.7, projectArea: 100, taskArea: 300};
  }},
  {id: 'S15', why: '弹窗出现第二个宽度/不居中 + 空态两种结构 + 未登记卡片密度 + 同页两个筛选', inject: d => {
    d.surfaces = {measured: true, dialogs: [{surface: 'projects', width: 760, centered: true}, {surface: 'tasks', width: 720, centered: false}], emptyStates: [{surface: 'projects', signature: 'img+h3+p+button'}, {surface: 'inbox', signature: 'text-only'}], cardDensities: ['standard', 'canvasNode', 'dense'], filterToggles: {projects: 2}};
  }}
];

/** 跑 canary：返回 [{id, why, caught, count}]。 */
export function canaryReport() {
  return CANARIES.map(canary => {
    const data = cleanFixture();
    // 先确认干净夹具是绿的（否则 canary 证明不了任何事）
    const before = runChecks(data).find(r => r.id === canary.id);
    canary.inject(data);
    const after = runChecks(data).find(r => r.id === canary.id);
    return {id: canary.id, why: canary.why, caught: !before.fail && after.fail, before: before.count, after: after.count};
  });
}
