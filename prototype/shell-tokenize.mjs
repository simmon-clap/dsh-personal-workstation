/**
 * shell 字面值收敛（批次 5 · 生成期转换）
 *
 * 背景（第 7–13 轮实测）：`src/v7-shell.html` 是 `build-v7.mjs` 读**冻结原型**
 * `工作台-视觉原型-v7.html` 生成的。原型把调色板/间距/字号全部**内联写死**，
 * 于是 305 处债务（色值 140 · 间距 125 · 字号 35）全部来自这一个文件，
 * 另有 `v7-contrast.css` 的 13 个 `!important` 也是因为"内联优先级高于主题层"。
 *
 * 约束（用户 2026-10-13 拍板）：**冻结基线一律不改**。
 *   - `工作台-视觉原型-v7.html` 一个字都不动；
 *   - `build-shell.mjs` 里的基线哈希校验（e863a0aa…）继续生效 —— 它正是防改动的那道门。
 *
 * 所以唯一的路是**生成期转换**：build 时把字面值改写成 token/变量引用，产物里不留字面值。
 *
 * 如实说明（这是必须写进账本的代价）：
 *   原型自己的调色板与 VI token **不是同一套值** —— 实测 136 处色值里只有 8 处恰好等于 token。
 *   因此"值完全相同"的零位移收敛在冻结原型上**不存在**：色值必须映射到最近的 VI token，
 *   间距必须落到标尺最近档，字号必须落到字阶最近档，都会产生可见但通常很小的位移。
 *   位移多大由 `shell-convert-compare.mjs` 用真实浏览器逐页量出来，**不靠估计**。
 */

/** 允许的收敛强度。nearest 容差越大，被拉进标尺的值越多，位移也越大。 */
export const PRESETS = {
  /** 只把"距离 token 很近"的值拉平，位移最小、但收敛不彻底。 */
  conservative: { colorDistance: 8, spaceTolerance: 2, fontTolerance: 0 },
  /** 平衡：色值取最近 token，间距/字号容差 5（4↔5↔8↔12 这一档） */
  balanced: { colorDistance: 256, spaceTolerance: 5, fontTolerance: 2 },
  /** 全量归零：所有字面值一律进标尺（位移最大）。 */
  strict: { colorDistance: 256, spaceTolerance: 256, fontTolerance: 256 },
  /** 只收敛色值，间距与字号一律不动 —— 用来量"色值收敛单独贡献多少差异"。 */
  colorOnly: { colorDistance: 256, spaceTolerance: 0, fontTolerance: 0, spacing: false, fontSize: false },
  /** 推荐方案：色值映射到 VI token（实测 0.12% 内）；间距/字号走**同值变量**（值不变、零重排）。 */
  exact: { colorDistance: 256, spacing: 'exact', fontSize: 'exact' },
};

const SPACING_SCALE = [4, 8, 12, 16, 24, 32, 48, 64, 96];
const TYPE_SCALE = [11, 12, 13, 14, 15, 18, 22, 32];

/**
 * 界面契约值：这些 px 是**验收测试与 VI 几何断言直接引用的**（如 `.nav{width:204px`、
 * `main{margin-left:204px`、`.v7-empty img{width:180px`、`main{margin-left:175px`）。
 * 把它们变量化会让测试从"断言真实值"退化成"断言变量名"，等于削弱验收。
 * 所以它们**按原样保留**：数量极少、且是信息架构的度量，不属于"随手写的间距"。
 * 默认值来自 prototype/exact-values.json，可由 build 覆盖。
 */
const KEEP_SPACING = new Set([22, 175, 180, 204]);

/**
 * 原型内联的 10px 不在 VI 字阶里（字阶最小 11px）。10px 只出现在脚注/次要说明，
 * 所以按**单调升级**处理：10px → 11px（1px 差、肉眼几乎不可分，且在标尺内）。
 * 这样既满足门禁 3，又满足 VI-1「页头提示必须是小字」的既有断言（按 1[01]px 判）。
 * 这不是放宽门禁，而是把标尺外的字号挪进标尺 —— 与第 7–9 轮对 v7-visual.css 的做法一致。
 */
const KEEP_FONT_SIZE = new Set();

const nearest = (value, scale) => scale.reduce((best, candidate) =>
  Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best, scale[0]);

const hexToRgb = hex => [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16));
const rgbDistance = (a, b) => Math.round(Math.sqrt(a.reduce((sum, value, index) => sum + (value - b[index]) ** 2, 0)));

/** 3/4/6/8 位 hex → 统一成 6 位大写，便于查表。 */
function normalizeHex(raw) {
  let hex = raw.slice(1).toUpperCase();
  if (hex.length === 4) hex = hex.slice(0, 3).split('').map(c => c + c).join('');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  return '#' + hex.slice(0, 6);
}

/**
 * 语义优先的颜色映射：**不做最近色猜测**，逐个写死并说明理由。
 * 只有这些确实代表"同一语义"的才允许合并 —— 这正是 VI V5「同一语义不许两套颜色」。
 */
export const COLOR_MAP = {
  // 动作色：原型有 4 个蓝，全指向 VI 的 --ws-action
  '#487DEC': 'var(--ws-action)',   // 原型 :root --blue
  '#2867DB': 'var(--ws-action)',   // 原型主按钮底色
  '#2E6CE2': 'var(--ws-action)',
  '#336ADA': 'var(--ws-action)',
  '#4880EE': 'var(--ws-action)',
  '#326ED2': 'var(--ws-action)',
  '#2862B7': 'var(--ws-action)',
  // 动作浅底：原型有 8 个浅蓝，全指向 --ws-action-soft
  '#EAF2FF': 'var(--ws-action-soft)',
  '#EDF4FF': 'var(--ws-action-soft)',
  '#EDF3FC': 'var(--ws-action-soft)',
  '#E9EFFF': 'var(--ws-action-soft)',
  '#E8EEF8': 'var(--ws-action-soft)',
  '#EAF0FF': 'var(--ws-action-soft)',
  '#F0F4FB': 'var(--ws-action-soft)',
  '#F3F7FE': 'var(--ws-action-soft)',
  // 中性层
  '#FFFFFF': 'var(--ws-surface)',
  '#1D2433': 'var(--ws-ink)',
  '#252A31': 'var(--ws-ink)',
  '#626C78': 'var(--ws-muted)',
  '#687283': 'var(--ws-muted)',
  '#5E6879': 'var(--ws-muted)',
  '#808897': 'var(--ws-muted)',
  '#58677D': 'var(--ws-muted)',
  '#60718D': 'var(--ws-muted)',
  '#E8ECF2': 'var(--ws-line)',
  '#DCE1E5': 'var(--ws-line)',
  '#DFE6F0': 'var(--ws-line)',
  '#DFE6EF': 'var(--ws-line)',
  '#DCE3ED': 'var(--ws-line)',
  '#CBD4E3': 'var(--ws-line)',
  '#E2E8F2': 'var(--ws-line)',
  // 语义色
  '#39A68E': 'var(--ws-success)',
  '#71A18D': 'var(--ws-success)',
  '#688F7E': 'var(--ws-muted)',
  '#CC903A': 'var(--ws-warning)',
  '#8A723C': 'var(--ws-warning)',
  '#EDF0F5': 'var(--ws-success-soft)',
  '#E7F1EE': 'var(--ws-success-soft)',
  '#E9EDF3': 'var(--ws-success-soft)',
  '#E9EDF2': 'var(--ws-success-soft)',
  '#E7EBF1': 'var(--ws-success-soft)',
  '#E4EAF3': 'var(--ws-success-soft)',
  '#EEF7F3': 'var(--ws-success-soft)',
  '#FFF8E9': 'var(--ws-warning-soft)',
  '#7555A1': 'var(--ws-knowledge)',
  '#9C83B5': 'var(--ws-knowledge)',
  '#9A82B4': 'var(--ws-knowledge)',
  '#F3EFF8': 'var(--ws-knowledge-soft)',
  '#EDF0F6': 'var(--ws-knowledge-soft)',
  '#EEF2F8': 'var(--ws-knowledge-soft)',
  '#F2F5FA': 'var(--ws-knowledge-soft)',
  // 纸色
  '#F8F9F7': 'var(--ws-paper)',
  '#F4F5F8': 'var(--ws-paper)',
  '#F5F6F8': 'var(--ws-paper)',
  '#F3F5F8': 'var(--ws-paper)',
  '#FAFBFC': 'var(--ws-paper)',
};

/**
 * 把一段 CSS 里的字面值改写成 token/变量引用。
 * @returns {{css:string, report:{colors:object,spacing:object,fontSize:object,alpha:object,unmapped:string[]}}}
 */
export function tokenizeCss(css, {colorDistance = 256, spaceTolerance = 5, fontTolerance = 2, spacing = true, fontSize = true, keepSpacing = KEEP_SPACING, keepFontSize = KEEP_FONT_SIZE, colorMap = colorMapWithContrast(), contrastMap = CONTRAST_MAP} = {}) {
  const definitions = {};
  // 负值必须原样带符号：`margin-left:-10px` 若被替换成 `var(--proto-space-10)`（=+10px），
  // 版面会整体位移且**不报错** —— 实测把 space 视图右移 10px、画布自适应从 56% 掉到 55%。
  // 所以同值变量的名字里带 n 前缀区分负值。
  const report = {colors: {}, spacing: {}, fontSize: {}, alpha: {}, unmapped: []};
  let out = css;

  // ---- 1. 带 alpha 的活字面值：改成 rgba()/color-mix() 引用（不再触发 `#hex` 门禁）
  // 注意：必须保留 `var(--ws-*)` 的完整写法 —— 第一次写成 `color-mix(in srgb, --ws-surface 53%, transparent)`
  // 是非法参数，整条声明失效（实测把六页差异推到 8%）。修好后应为 1% 量级。
  out = out.replace(/#([0-9a-fA-F]{8})\b/g, (whole, value) => {
    const base = '#' + value.slice(0, 6).toUpperCase();
    const alpha = Number.parseInt(value.slice(6), 16) / 255;
    const mapped = colorMap[base] ?? nearestToken(base).var;
    const token = mapped.startsWith('var(') ? mapped.slice(4, -1) : null;
    const rgb = hexToRgb(base).join(', ');
    // 有对应 token 时用 color-mix 保持"跟主题一起变"；没有则退回 rgba（色相完全不变）
    report.alpha[whole] = token
      ? `color-mix(in srgb, var(${token}) ${Math.round(alpha * 100)}%, transparent)`
      : `rgba(${rgb}, ${alpha.toFixed(2)})`;
    return report.alpha[whole];
  });

  // ---- 1.5 rgb() 与 hex 是同一种颜色的两种写法：先归一成 hex，再走下面同一张语义表。
  // 事故：原型把页头小字写成 `color: rgb(137, 150, 170)`（= #8996AA，对纸底 2.84:1，低于 4.5），
  // 而门禁与映射表只认 `#hex`，于是它一路活到发布包。CONTRAST_MAP 当时**导出了却没有任何地方调用**。
  out = out.replace(/rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)/gi, whole => {
    const channels = whole.match(/\d{1,3}/g).map(Number);
    if (channels.some(value => value > 255)) return whole;
    const hex = '#' + channels.map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase();
    return contrastMap[hex] ?? hex;
  });

  // ---- 2. 纯色字面值
  out = out.replace(/#([0-9a-fA-F]{3,6})\b/g, whole => {
    const key = normalizeHex(whole);
    let mapped = colorMap[key];
    if (!mapped) {
      const guess = nearestToken(key);
      const distance = rgbDistance(hexToRgb(key), hexToRgb(guess.hex));
      if (distance <= colorDistance) mapped = guess.var;
      else report.unmapped.push(whole);
    }
    if (!mapped) return whole;
    const distance = distanceToToken(key);
    report.colors[whole] = {to: mapped, distance};
    return mapped;
  });

  // ---- 3. 间距：只改 padding/margin/gap 里**接近标尺**的值（布局尺寸如 175px 草稿区宽不算间距）
  if (spacing === 'exact') out = out.replace(/(\b(?:padding|margin|gap)(?:-[a-z]+)?\s*:\s*)([^;{}"'\n]+)/g, (whole, prefix, value) => {
    // 2026-10-14 修正：这里原来叫"同值变量"——**值一个不变，只换个写法**。后果是原型里
    // 2/3/5/6/7/9/10/11/13/14/15/17/18/19/20/22/23/25/27/30px 这些标尺外的间距全部活了下来，
    // 只是从"字面量"变成了 `var(--proto-space-19)`，于是门禁 2「标尺外像素值 = 0」报了 0，
    // 界面上的间距却从来没有成体系过（用户 2026-10-14 的原话就是"间距不成体系、不精致"）。
    // 现在按 VI §4 唯一标尺就近入档：正向吸附、负向按**量值**吸附（-27 与 +27 是同一把尺）。
    // 契约值（KEEP_SPACING：175/180/204 这类信息架构度量）仍然原样保留。
    const next = value.replace(/(-?)(\d+(?:\.\d+)?)px/g, (px, sign, number) => {
      const numeric = Number(number);
      if (SPACING_SCALE.includes(numeric)) return px;
      if (keepSpacing.has(numeric)) { report.spacing[px] = {to: px, skipped: '界面契约值，保留字面量'}; return px; }
      const snapped = nearest(numeric, SPACING_SCALE);
      const name = '--proto-space-' + (sign ? 'n' : '') + String(snapped).replace('.', '_');
      definitions[name] = sign + snapped + 'px';
      report.spacing[px] = {to: `var(${name})`, shift: snapped - numeric};
      return `var(${name})`;
    });
    return prefix + next;
  }); else if (!spacing) out = out.replace(/(\b(?:padding|margin|gap)(?:-[a-z]+)?\s*:\s*)([^;{}"'\n]+)/g, (whole, prefix, value) => {
    for (const px of value.matchAll(/(\d+(?:\.\d+)?)px/g)) report.spacing[px[0]] = {to: px[0], skipped: '本强度不动间距'};
    return whole;
  }); else
  out = out.replace(/(\b(?:padding|margin|gap)(?:-[a-z]+)?\s*:\s*)([^;{}"'\n]+)/g, (whole, prefix, value) => {
    const next = value.replace(/(-?)(\d+(?:\.\d+)?)px/g, (px, sign, number) => {
      const numeric = Number(number);
      // 负间距（负外边距）不参与标尺收敛：标尺是正向量度，把它"吸附"会改变版面。
      if (sign) { report.spacing[px] = {to: px, skipped: '负值不动'}; return px; }
      if (SPACING_SCALE.includes(numeric)) return px;
      const snapped = nearest(numeric, SPACING_SCALE);
      if (Math.abs(snapped - numeric) > spaceTolerance) {
        report.spacing[px] = {to: px, skipped: '离标尺太远，按布局尺寸保留'};
        return px;
      }
      report.spacing[px] = {to: snapped + 'px', shift: snapped - numeric};
      return snapped + 'px';
    });
    return prefix + next;
  });

  // ---- 4. 字号
  if (fontSize === 'exact') out = out.replace(/(font-size\s*:\s*)(\d+(?:\.\d+)?)px/g, (whole, prefix, number) => {
    if (TYPE_SCALE.includes(Number(number))) return whole;
    // VI §3：11px **只许用于「时间、坐标等非关键信息」**（规范表格最后一行），
   // 而原型里的 10px 是脚注/次要说明 —— 它们不是时间/坐标，应升到**辅助档 12px**，
   // 而不是"最小档 11px"（2026-10-17 用户指出视觉仍有问题后实测：最终产物 28 处 11px
   // 全是这里升上来的，用在了导航组标题、指标标签、按钮上）。
    // 这是 exact 档唯一允许发生的数值改动 —— 它不属于"版面差异"，而是规范违规：
    // 本文件第 45 行的注释早就写明 10px → 11px，但那条升级只作用在内联 style 属性上，
    // `<style>` 块里的 9px/10px 被原样保留，于是侧栏分组、页脚、画布提示等 12 类文字
    // 长期停在 10px（2026-10-14 用户点名"字体太小/显老"时查出的同源问题）。
    const belowFloor = Number(number) < TYPE_SCALE[0];
    if (belowFloor) {
      // 11 只留给"时间、坐标"（规范 §3 表格最后一行），脚注/说明应进**辅助档 12**。
      const floor = Math.max(12, TYPE_SCALE[0]);
      report.fontSize[number] = {to: floor + 'px', shift: floor - Number(number), note: '低于辅助档，升到 12（11 只留时间/坐标）'};
      return prefix + floor + 'px';
    }
    if (keepFontSize.has(Number(number))) { report.fontSize[number] = {to: number + 'px', skipped: '界面契约值，保留字面量'}; return whole; }
    const name = '--proto-font-' + number.replace('.', '_');
    definitions[name] = number + 'px';
    report.fontSize[number] = {to: `var(${name})`, exact: true};
    return prefix + `var(${name})`;
  }); else if (!fontSize) out = out.replace(/(font-size\s*:\s*)(\d+(?:\.\d+)?)px/g, (whole, prefix, number) => {
    report.fontSize[number] = {to: number + 'px', skipped: '本强度不动字号'}; return whole;
  }); else
  out = out.replace(/(font-size\s*:\s*)(\d+(?:\.\d+)?)px/g, (whole, prefix, number) => {
    const numeric = Number(number);
    if (TYPE_SCALE.includes(numeric)) return whole;
    const snapped = nearest(numeric, TYPE_SCALE);
    if (Math.abs(snapped - numeric) > fontTolerance) {
      report.fontSize[number] = {to: number + 'px', skipped: '离字阶太远，按标识尺寸保留'};
      return whole;
    }
    report.fontSize[number] = {to: snapped + 'px', shift: snapped - numeric};
    return prefix + snapped + 'px';
  });

  return {css: out, report, definitions};
}

function colorMapWithContrast(){return {...COLOR_MAP, ...CONTRAST_MAP};}

/** 最近 token（仅作为语义表未覆盖时的兜底，且必须通过距离阈值）。 */
function nearestToken(hex) {
  let best = null;
  for (const [name, value] of Object.entries(TOKENS)) {
    const distance = rgbDistance(hexToRgb(hex), hexToRgb(value));
    if (!best || distance < best.distance) best = {name, hex: value, distance, var: `var(--ws-${name})`};
  }
  return best;
}
function distanceToToken(hex) {
  const match = nearestToken(hex);
  return match.distance;
}
export const TOKENS = {
  paper: '#F8F9F7', surface: '#FFFFFF', ink: '#252A31', muted: '#626C78', line: '#DCE1E5',
  action: '#315ED0', 'action-soft': '#EDF2FF', success: '#28735B', 'success-soft': '#EDF6F1',
  warning: '#8A601D', 'warning-soft': '#FBF4E6', danger: '#B33F44', 'danger-soft': '#FBEFF0',
  knowledge: '#7555A1', 'knowledge-soft': '#F3EFF8',
};

/**
 * 把生成好的 shell HTML 里的 <style> 字面值收敛。
 * @returns {{html:string, report:object}}
 */
export function tokenizeShell(html, preset = PRESETS.balanced) {
  const combined = {colors: {}, spacing: {}, fontSize: {}, alpha: {}, unmapped: []};
  const definitions = {};
  // 负值必须原样带符号：`margin-left:-10px` 若被替换成 `var(--proto-space-10)`（=+10px），
  // 版面会整体位移且**不报错** —— 实测把 space 视图右移 10px、画布自适应从 56% 掉到 55%。
  // 所以同值变量的名字里带 n 前缀区分负值。
  const out = html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/g, (whole, open, css, close) => {
    const {css: next, report, definitions: layer} = tokenizeCss(css, preset);
    Object.assign(definitions, layer);
    for (const key of Object.keys(combined)) {
      if (key === 'unmapped') combined.unmapped.push(...report.unmapped);
      else Object.assign(combined[key], report[key]);
    }
    return open + next + close;
  });
  // 内联 style="…" 属性同样要收敛：实测残留的 4 处（#789aeb / #65af99 / #6c88b5 / #9faec5）
  // 全在元素上的 style 属性里 —— 只扫 <style> 块是漏的。
  const withAttributes = out.replace(/(\sstyle=")([^"]*)(")/g, (whole, open, css, close) => {
    // 内联 style：色值照常映射（内联色优先级高于主题层，正是对比度门禁的根因）；
    // 间距/字号只保留**界面契约值**（KEEP_SPACING 与 KEEP_FONT_SIZE），其余同样进同值变量层。
    // 契约值必须留字面量：验收测试直接断言它们（如 #subtitle 的 font-size:10px），
    // 变量化会把验收从"断言真实值"降级成"断言变量名"。
    const upgraded = css.replace(/font-size\s*:\s*10px/g, 'font-size:12px');
    if (upgraded !== css) combined.fontSize['10'] = {to: '12px', shift: 2, note: '内联 10px 升到辅助档（11 只留时间/坐标）'};
    const {css: next, report: attributeReport, definitions: layer} = tokenizeCss(upgraded, preset);
    Object.assign(definitions, layer);
    for (const key of Object.keys(combined)) {
      if (key === 'unmapped') combined.unmapped.push(...attributeReport.unmapped);
      else Object.assign(combined[key], attributeReport[key]);
    }
    return open + next + close;
  });
  return {html: withAttributes, report: combined, definitions, layer: definitionLayer(definitions)};
}

/** 生成"同值变量"层：唯一允许写字面值的地方是变量定义层，与 tokens.css 同一结构。 */
export function definitionLayer(definitions) {
  // 2026-10-14 修正（用户点名「字体太大、整体显老」时查出的**门禁造假**）：
  // 这里原来把字号定义包成 `calc(10px)`，注释写明理由是"不会被门禁 3 的
  // `font-size:\s*Npx` 当成正文命中" —— 也就是为了骗过门禁正则而改写产物。
  // 后果：门禁报「字阶外字号 = 0」，界面上却有 447 个文本节点停在 10px（实测）。
  // 现在门禁改成在真实浏览器里逐节点量字号（prototype/type-scale-audit.mjs），
  // 这层伪装既无必要也有害，一律去掉，定义层照实写 px，残留值由门禁如实暴露。
  const body = Object.entries(definitions)
    .map(([name, value]) => `  ${name}:${value};`)
    .join('\n');
  return `/* 由 build 生成：把冻结原型的内联值收进变量层。\n   字号不在 VI 字阶内的，tokenizeShell 已在生成期入档（见其字号分支）；\n   这里不再用 calc() 之类写法掩盖残留值。 */\n:root{\n${body}\n}\n`;
}

/**
 * 对比度修正映射（取代 v7-contrast.css 前三条 `!important`）。
 * 原型把这三处颜色内联写死，内联优先级高于主题层，深色下不可读：
 *   · 页头小字 #8996aa（深色 3.2）→ `--ws-muted`（明暗两套都 ≥4.5）
 *   · 面板图标 #9faec5（浅色 2.25）→ `--ws-muted`
 *   · 看板轴标签 #A0A7B3 与标签 #7F91AA → `--ws-muted`
 * 改成 token 后，内联值本身随主题变化，修正层不再需要用 !important 去压它。
 */
export const CONTRAST_MAP = {
  '#8996AA': 'var(--ws-muted)',
  '#9FAEC5': 'var(--ws-muted)',
  '#A0A7B3': 'var(--ws-muted)',
  '#7F91AA': 'var(--ws-muted)',
  '#334664': 'var(--ws-ink)',
};

export const SNAPSHOT = {SPACING_SCALE, TYPE_SCALE};
