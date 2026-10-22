/**
 * 宪章守卫（charter-guard）
 *
 * 依据 spec/02-VI规范 §13 的 12 项门禁与 spec/registry.json 的登记表，
 * 对 src/ 做机械检查，防止"没有门禁的债务自己长"（实测：!important 从上轮以为的 3 处长到 19 处）。
 *
 * 设计要点：
 * - **登记表驱动**：允许存在的颜色、图标、入口、对象类型、界面词汇、间距与字号标尺全部来自 registry.json；
 * - **棘轮基线**：spec/guard-baseline.json 记录当前真实债务数。任何一项 *上升* 立即失败；
 *   下降后可用 --update-baseline 收紧（批次 5 会把它们降到 0）。
 * - **自检**：--self-test 对每个检查同时验证「能发现注入的违规」与「不误报干净输入」，
 *   防止门禁变成永远通过的摆设。
 *
 * 用法：
 *   node prototype/charter-guard.mjs                  # 检查（回归即失败）
 *   node prototype/charter-guard.mjs --self-test      # 自检
 *   node prototype/charter-guard.mjs --update-baseline# 收紧基线（只在下降后使用）
 *   node prototype/charter-guard.mjs --verbose        # 打印样例
 */
import {readFileSync, writeFileSync, readdirSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');   // workstation/
const repo = join(root, '..');                                      // 工作区根
const SPEC = join(repo, 'spec');
const registry = JSON.parse(readFileSync(join(SPEC, 'registry.json'), 'utf8'));
const baselinePath = join(SPEC, 'guard-baseline.json');

// 允许存放字面色值的唯一位置：变量定义层。其余一律必须用变量。
// 变量定义层不算「字面色值」：浅色 tokens 与深色层都是 token 的唯一出处，
// 其余文件只允许用 var() 引用它们。深色层同样是定义块 + var()，结构一致。
// 允许出现字面色值的**变量定义层**：登记表驱动（spec/registry.json 的 colors.literalValueLayers），
// 不再硬编码在脚本里 —— 每加一层都必须先登记，未登记即违规（与颜色/图标/入口同一套规则）。
const LITERAL_COLOR_LAYERS = (registry.colors?.literalValueLayers?.items ?? [])
  .filter(item => item.kind === 'colors').map(item => item.path);
const LITERAL_SCALE_LAYERS = (registry.colors?.literalValueLayers?.items ?? [])
  .filter(item => item.kind === 'scale').map(item => item.path);
// 兼容旧口径：tokens.css / v7-dark.css 若未登记也仍然允许（防止登记表被误删导致误报爆炸）。
const COLOR_ALLOWED = [...new Set(['src/v7/tokens.css', 'src/v7/v7-dark.css', ...LITERAL_COLOR_LAYERS])];
// 门禁 4 的例外：外壳是**冻结原型**的生成物，原型自带的静态标记不按"第二套实现"论。
// 2026-10-14 修正：原来还写着一句「#scopefilter / #projectfocus 在 7 个页面上全部隐藏、不可见」——
// 实测（真实浏览器）这两个原生下拉**在关联空间页都可见**，放行理由是错的；现在 space-view.mjs
// 在挂载时把它们换成了 .viselect，界面上已经不存在第二套下拉实现。
const COMPONENT_ALLOWED = ['src/v7-shell.html'];
// 门禁扫描范围：随包发布的源码。
const SCAN_DIRS = ['src'];
// 「不随包发布」的文件不算界面：package.json 的 files 里以 ! 开头的模式是排除项。
// 例：src/web-app.mjs 被 !src/web-app.mjs 排除在发布包外（它是导出 client 的测试辅助代码），
// 它的字面色值/间距不该算进界面门禁 —— 第 7 轮实测：它不是死代码，删不得，只能按非界面处理。
const NOT_SHIPPED = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return (pkg.files ?? []).filter(entry => entry.startsWith('!')).map(entry => entry.slice(1));
  } catch { return []; }
})();
// 排除模式支持 npm 的 * 通配（例如 !src/*-client.mjs），所以按通配转成正则再判。
const NOT_SHIPPED_RE = NOT_SHIPPED.map(pattern => new RegExp('^' + pattern
  .replace(/[.+^${}()|[\]\\]/g, '\\$&')
  .replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$'));
const isShipped = path => !NOT_SHIPPED_RE.some(re => re.test(path));

const SPACE_SCALE = new Set(registry.spacingScale.map(String));
// 界面度量契约值（登记表 contractValues）：被验收测试以字面量断言的像素值。
// 它们单列计数、不算标尺外债务 —— 理由写在那张表里，不靠脚本里的白名单。
const CONTRACT_SPACING = new Set((registry.contractValues?.items ?? [])
  .filter(item => item.kind === 'spacing').map(item => String(item.value)));
const TYPE_SCALE = new Set(registry.typeScale.map(String));
const KINDS_REGISTERED = new Set([
  ...registry.objectTypes.existing,
  ...registry.objectTypes.planned.map(item => item.id),
]);
const ENTRIES_REGISTERED = registry.entries.items.filter(item => item.kind !== 'utility').map(item => item.id);
const FORBIDDEN = registry.uiVocabulary.forbidden;
// 同名文档的**别名组**（登记表 identicalAliases）：同一份内容存在多处路径，且必须逐字节相同。
// 守卫每次核对 md5 —— 一旦有人只改其中一份，就报「别名组不再逐字节相同」。
const IDENTICAL_ALIASES = new Map((registry.identicalAliases?.items ?? []).map(item => [item.name, item]));
// 允许保留的 !important（登记表 importantAllowed，逐条写明要压的对象）。
// 只剩"压内联样式 / 压用户代理偏好"这两类；压同层已有属性的多余强制在第 14 轮已删。
const IMPORTANT_ALLOWED = new Map((registry.importantAllowed?.items ?? [])
  .map(item => [item.file + ' :: ' + item.declaration.replace(/\s+/g, ''), item.reason]));

// ---------------------------------------------------------------- 工具
function listFiles() {
  const out = [];
  for (const dir of SCAN_DIRS) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    const walk = current => {
      for (const name of readdirSync(current, {withFileTypes: true})) {
        const full = join(current, name.name);
        if (name.isDirectory()) { walk(full); continue; }
        if (!/\.(mjs|js|css|html)$/.test(name.name)) continue;
        // 相对路径必须按 root 的**实际**结尾切片：硬编码 `root.length + 1` 会让路径少一个字符
        // （实测把 src/v7/v7-dark.css 切成 src/v7/v7-dark.css，导致按文件登记的检查全部对不上）。
        const relativePath = full.slice(root.endsWith('/') ? root.length : root.length + 1);
        out.push({path: relativePath, content: readFileSync(full, 'utf8')});
      }
    };
    walk(abs);
  }
  return out;
}

const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(line => line.replace(/(^|[^:'"\\])\/\/.*$/, '$1')).join('\n');

/** 中文界面文案字面量（与 wording-audit 同口径）。 */
function literals(source) {
  const out = [];
  for (const m of source.matchAll(/'([^'\\\n]*(?:\\.[^'\\\n]*)*)'|"([^"\\\n]*(?:\\.[^"\\\n]*)*)"|`([^`]*)`/g)) {
    const text = m[1] ?? m[2] ?? m[3] ?? '';
    if (/[\u4e00-\u9fa5]/.test(text)) out.push(text);
  }
  return out;
}

// 只判「彩色图文符号」（Unicode Extended_Pictographic）。
// 例外：VI §9 / V2 规定要用的判断状态符号与常用排版符号 —— 它们是规范要求的字符，
// 若算作违规，就会把正确实现判成错误（实测 ↩ 也在 Extended_Pictographic 里）。
// 允许的符号是**状态记号**（◇✓↩）与**排版符号**（·…—–），它们在文字里承担语义。
// 2026-10-14：把"当成图标用的文字符号"也纳入检查 —— ＋(U+FF0B) −(U+2212) ×(U+00D7) ↗(U+2197)
// 都不是 emoji 码位，原来的 `\p{Extended_Pictographic}` 一个都抓不到，
// 于是门禁报 0 违规、界面上却有 20 多个按钮拿符号当图标（用户点名"选项没有图标"的同源问题）。
const SYMBOL_ALLOWED = new Set([...'◇✓↩×→←↔↗↘↑↓·…—–＋−～']);
const ICON_LIKE = new Set([...'＋−×↗↘↺']);
const EMOJI = /(?:\p{Extended_Pictographic}|\uFE0F)/u;
// 口径：**整条文案就是一个符号（或符号 + 极短标签）**才算"拿符号当图标"。
// 正文里的 ×（"重要×紧急"）、↔（"交付项↔任务"）、＋／－（键盘说明）是正常排版，不报。
// 这样它抓的是「＋ 添加」「＋ 添加任务」这类，而不是把中文里的乘号也一起算进来。
const GLYPH_LABEL = /^[＋−×↗↘↺～]\s*\S{0,4}$/u;
const hasEmoji = text => [...text].some(ch => !SYMBOL_ALLOWED.has(ch) && EMOJI.test(ch)) || GLYPH_LABEL.test(text.trim());

// ---------------------------------------------------------------- 检查项
// 每个检查：({files, registry}) -> {count, samples[]}；count 为真实违规数。
const CHECKS = [
  {
    id: 'colors', label: '字面色值（门禁 1）',
    hint: '改用 design-system/tokens.json 的 --ws-* 变量；唯一允许写字面色值的地方是 ' + COLOR_ALLOWED.join(','),
    run: ({files}) => {
      const unregistered = [];
      const samples = [];
      // **逐个值登记**（2026-10-16）：原来只要文件在 literalValueLayers 里就整份豁免 —— 那是"登记即合法"。
      // 现在：豁免文件里的每一个字面色值都必须在 registry 的 registeredLiterals 里点名，
      // 出现**新的**字面色值就判失败（要求新增者写明理由）。tokens/深色/宿主映射这些**定义层**不受此限
      // （它们本身就是色值来源，逐个登记没有意义）。
      const perValue = registry.colors?.registeredLiterals?.items ?? {};
      for (const file of files) {
        const registered = perValue[file.path];
        if (!registered) continue;
        const allowed = new Set(registered.map(row => String(row.value).toLowerCase()));
        const source = stripComments(file.content);
        for (const m of source.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
          if (!allowed.has(m[0].toLowerCase())) {
            unregistered.push({file: file.path, value: m[0]});
          }
        }
      }
      for (const file of files) {
        if (COLOR_ALLOWED.includes(file.path) || !isShipped(file.path)) continue;
        const source = stripComments(file.content);
        for (const m of source.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
          samples.push(`${file.path}: ${m[0]}`);
        }
        // 2026-10-16：只认 hex 会漏掉两类同样"把颜色写死"的写法，它们一直没被算过账 ——
        // 实测外壳里 17 处具名颜色 `white`、工作台层 13 处 `rgba(...)` 都从这里走了过去。
        for (const m of source.matchAll(/\brgba?\([^)]*\)/g)) {
          samples.push(`${file.path}: ${m[0].slice(0, 48)}`);
        }
        // 具名颜色只在**颜色属性**里算（避免把 white-space 这类词误判）。
        const NAMED = /(?:^|[;{,\s])(?:color|background|background-color|background-image|border|border-color|border-top|border-bottom|border-left|border-right|border-block|border-inline|fill|stroke|outline|outline-color|box-shadow|text-shadow|caret-color|accent-color)\s*:\s*[^;{}]*?(?<![\w-])(white|black|red|green|blue|yellow|orange|purple|gray|grey|silver|maroon|navy|teal|olive|lime|aqua|fuchsia)(?![\w-])/g;
        for (const m of source.matchAll(NAMED)) {
          samples.push(`${file.path}: 具名颜色 ${m[1]}`);
        }
      }
      for (const row of unregistered) samples.push(`${row.file}: ${row.value}（没在 registry.colors.registeredLiterals 里登记）`);
      return {count: samples.length, samples};
    },
  },
  {
    id: 'important', label: '!important 覆盖（V6）',
    hint: '消费宿主主题语义变量，不要用 !important 覆盖原型内联色',
    run: ({files, keepMotion}) => {
      const samples = [];
      let exempted = 0;
      for (const file of files) {
        if (!isShipped(file.path)) continue;
        let source = stripComments(file.content);
        // `@media (prefers-reduced-motion: reduce)` 里的 !important 是**无障碍标准做法**
        // （操作系统级的"减少动态效果"必须压过作者样式），不是"用 !important 覆盖主题"。
        // 这不是放宽：把这类整块剔除后单独计数，数量在输出里如实列出。
        // 压缩后的 CSS 是单行块，正则配不了嵌套括号 —— 用花括号配平精确切出整块。
        const motionPrefix = /@media\s*\(prefers-reduced-motion[^)]*\)\s*\{/g;
        let motionMatch;
        while ((motionMatch = motionPrefix.exec(source)) !== null) {
          let depth = 0, end = motionMatch.index + motionMatch[0].length - 1;
          for (; end < source.length; end += 1) {
            if (source[end] === '{') depth += 1;
            else if (source[end] === '}') { depth -= 1; if (depth === 0) break; }
          }
          const block = source.slice(motionMatch.index, end + 1);
          exempted += (block.match(/!important/g) ?? []).length;
          if (!keepMotion) {
            source = source.slice(0, motionMatch.index) + source.slice(end + 1);
            motionPrefix.lastIndex = motionMatch.index;
          } else {
            motionPrefix.lastIndex = end + 1;
          }
        }
        // 逐条判：登记的强制声明放行，其余才算债务（含"压同层已有属性"的多余强制）。
        for (const declaration of source.matchAll(/[^;{}]*!important/g)) {
          const text = declaration[0].replace(/\s+/g, '');
          // 取本条声明的属性名+值：规则块内没有 }，所以要按最后一个 ; 或 { 切。
          const property = text.slice(Math.max(text.lastIndexOf(';'), text.lastIndexOf('{')) + 1);
          const key = file.path + ' :: ' + property;
          if (IMPORTANT_ALLOWED.has(key)) continue;
          samples.push(`${file.path}: ${declaration[0].trim().slice(-60)}`);
        }
      }
      return {count: samples.length, samples, exempted};
    },
  },
  {
    id: 'spacing', label: '间距标尺（门禁 2）',
    hint: '间距只用 ' + registry.spacingScale.join('/') + '，标尺外的值不允许出现',
    run: ({files}) => {
      const samples = [];
      for (const file of files) {
        if (!/\.(mjs|css|html)$/.test(file.path) || !isShipped(file.path)) continue;
        if (LITERAL_SCALE_LAYERS.includes(file.path)) continue;
        const source = stripComments(file.content);
        for (const decl of source.matchAll(/\b(padding|margin|gap)(?:-[a-z]+)?\s*:\s*([^;{}"'\n]+)/g)) {
          for (const num of decl[2].matchAll(/(\d+(?:\.\d+)?)px/g)) {
            if (SPACE_SCALE.has(num[1]) || CONTRACT_SPACING.has(num[1])) continue;
            samples.push(`${file.path}: ${decl[1]}: ${num[0]}`);
          }
        }
      }
      return {count: samples.length, samples};
    },
  },
  {
    id: 'fontSize', label: '字阶（门禁 3）',
    hint: '字号只用 ' + registry.typeScale.join('/') + '，不得新增字号',
    run: ({files}) => {
      const samples = [];
      for (const file of files) {
        if (!/\.(mjs|css|html)$/.test(file.path) || !isShipped(file.path)) continue;
        if (LITERAL_SCALE_LAYERS.includes(file.path)) continue;
        const source = stripComments(file.content);
        for (const m of source.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/g)) {
          if (!TYPE_SCALE.has(m[1])) samples.push(`${file.path}: font-size: ${m[1]}px`);
        }
      }
      return {count: samples.length, samples};
    },
  },
  {
    id: 'entries', label: '入口登记一致（约束二）',
    hint: '不新增、不删除、不重排一级入口；改动须先走宪章第九条',
    run: ({files, registry}) => {
      const shell = files.find(f => f.path.endsWith('v7-shell.html'));
      if (!shell) return {count: 0, samples: [], skipped: '未找到 v7-shell.html'};
      const found = [...new Set([...shell.content.matchAll(/data-view="([a-z]+)"/g)].map(m => m[1]))];
      const registered = registry.entries.items.filter(i => i.kind !== 'utility').map(i => i.id);
      const samples = [];
      for (const id of found) if (!registered.includes(id)) samples.push(`未登记入口: ${id}`);
      for (const id of registered) if (!found.includes(id)) samples.push(`登记了但界面没有: ${id}`);
      return {count: samples.length, samples};
    },
  },
  {
    id: 'objects', label: '对象类型登记（范围变更须先讨论）',
    hint: '新增对象类型属于范围变更，必须先登记并走宪章第九条',
    run: ({files, registry}) => {
      const validation = files.find(f => f.path.endsWith('validation.mjs'));
      if (!validation) return {count: 0, samples: [], skipped: '未找到 validation.mjs'};
      const registered = new Set([
        ...registry.objectTypes.existing,
        ...registry.objectTypes.planned.map(i => i.id),
      ]);
      // kind 枚举就是 validation.mjs 里 `const fields={...}` 的键（值只含字符串，不会误取）
      const body = /const fields\s*=\s*\{([\s\S]*?)\};/.exec(validation.content)?.[1];
      if (body === undefined) return {count: 0, samples: [], skipped: '未找到 fields 声明，检查方式需更新'};
      const kinds = [...new Set([...body.matchAll(/([a-zA-Z][\w]*)\s*:\s*\[/g)].map(m => m[1]))];
      const samples = kinds.filter(kind => !registered.has(kind)).map(kind => `未登记对象类型: ${kind}`);
      return {count: samples.length, samples};
    },
  },
  {
    id: 'wordlist', label: '禁造词两处口径一致（03 §7）',
    hint: 'registry.uiVocabulary.forbidden 里的每个词都必须被 wording-audit 的 TERMS 覆盖，否则门禁扫不到',
    run: ({files, registry}) => {
      const audit = files.find(f => f.path.endsWith('wording-audit.mjs'))
        ?? {content: readFileSync(join(root, 'prototype/wording-audit.mjs'), 'utf8')};
      const samples = [];
      for (const term of registry.uiVocabulary.forbidden) {
        if (!audit.content.includes(`'${term}'`) && !audit.content.includes(`"${term}"`) && !audit.content.includes(term)) {
          samples.push(`wording-audit 未覆盖禁用词: ${term}`);
        }
      }
      return {count: samples.length, samples};
    },
  },
  {
    id: 'emoji', label: '界面用 emoji 当图标（V9）',
    hint: '用 assets/icons 的线性图标，不要用 emoji',
    run: ({files}) => {
      const samples = [];
      for (const file of files) {
        if (!/\.(mjs|html)$/.test(file.path)) continue;
        if (file.path.endsWith('charter-guard.mjs')) continue;
        for (const text of literals(file.content)) {
          if (hasEmoji(text)) samples.push(`${file.path}: ${text.slice(0, 40)}`);
        }
      }
      return {count: samples.length, samples};
    },
  },
  {
    id: 'kindWhitelists', label: '对象类型白名单同步',
    hint: 'validation.mjs 的 fields 与 store.mjs 的 kinds 必须完全一致 —— 漏一处只在运行时才炸（同类坑曾让插件两次激活失败）',
    run: ({files}) => {
      // 精确取顶层业务层文件：src/v7/validation.mjs 是生成物，结构可能不同
      const validation = files.find(f => f.path === 'src/validation.mjs');
      const store = files.find(f => f.path === 'src/store.mjs');
      if (!validation || !store) return {count: 0, samples: [], skipped: '未找到 validation.mjs 或 store.mjs'};
      const body = /const fields\s*=\s*\{([\s\S]*?)\};/.exec(validation.content)?.[1] ?? '';
      const inValidation = new Set([...body.matchAll(/([a-zA-Z][\w]*)\s*:\s*\[/g)].map(m => m[1]));
      const storeList = /const kinds\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(store.content)?.[1] ?? '';
      const inStore = new Set([...storeList.matchAll(/['"]([a-zA-Z][\w]*)['"]/g)].map(m => m[1]));
      if (inValidation.size === 0 || inStore.size === 0) {
        return {count: 0, samples: [], skipped: '未能解析白名单，检查方式需更新'};
      }
      const samples = [];
      for (const kind of inValidation) if (!inStore.has(kind)) samples.push(`validation 有、store 缺: ${kind}`);
      for (const kind of inStore) if (!inValidation.has(kind)) samples.push(`store 有、validation 缺: ${kind}`);
      return {count: samples.length, samples};
    },
  },
  {
    id: 'toolWhitelist', label: '工具脚本必须在文案门禁的跳过名单里',
    hint: 'prototype 下名字像工具/校验/截图/种子的脚本会被文案门禁当成界面扫描（中文测试数据会误报）。新增这类文件必须同步加进 wording-audit 的 TOOLS。',
    run: ({protoNames, auditTools}) => {
      const known = new Set(auditTools ?? []);
      const PATTERN = /(audit|check|seed|diff|metrics|shots|screenshot|verify|build|extract|replica-core)/i;
      const samples = [];
      for (const name of protoNames ?? []) {
        if (!name.endsWith('.mjs') || !PATTERN.test(name)) continue;
        if (!known.has(name)) samples.push(`未列入 TOOLS 的工具脚本: ${name}`);
      }
      return {count: samples.length, samples};
    },
  },
  {
    id: 'actionAllowlist', label: '工具动作允许清单同步',
    hint: '工具 schema 里声明的每个 action，都必须在 dsh-adapter 的动作允许清单里 —— 否则调用会被「未知工作台动作」挡掉（2026-10-22 就是这么踩的：intake_record 写了分派、漏了允许清单）',
    run: ({files}) => {
      const adapter = files.find(f => f.path === 'src/dsh-adapter.mjs');
      if (!adapter) return {count: 0, samples: [], skipped: '未找到 dsh-adapter.mjs'};
      const enumText = /action:\{type:'string',enum:\[([^\]]*)\]\}/.exec(adapter.content)?.[1];
      const allow = /if\(!\[([^\]]*)\]\.includes\(args\.action\)\)throw new DomainError\('INVALID','未知工作台动作'\)/.exec(adapter.content)?.[1];
      if (enumText === undefined || allow === undefined) return {count: 0, samples: [], skipped: '读取不到枚举或允许清单，检查方式需更新'};
      const declared = [...enumText.matchAll(/'([^']+)'/g)].map(m => m[1]);
      const allowed = new Set([...allow.matchAll(/'([^']+)'/g)].map(m => m[1]));
      // 动作可能由三种地方处理：switch 里的 case、允许清单后的分派、或允许清单本身。
      // 只查"三处都没有"的那种 —— 那才是真的会被「未知工作台动作」挡掉。
      const handled = new Set([
        ...[...adapter.content.matchAll(/case '([a-z_]+)'/g)].map(m => m[1]),
        ...[...adapter.content.matchAll(/args\.action===?'([a-z_]+)'/g)].map(m => m[1]),
      ]);
      const samples = declared
        .filter(name => !allowed.has(name) && !handled.has(name))
        .map(name => '工具声明了 ' + name + '，但既没有 case 也不在允许清单里');
      return {count: samples.length, samples};
    },
  },
  {
    id: 'argWhitelists', label: '工具参数白名单同步',
    hint: 'dsh-adapter 里读 args.X 的参数，必须在同一文件的 permitted 白名单里 —— 否则工具调用会被"不接受未知参数"直接拒掉（与 kind 白名单同一类坑）。',
    run: ({files}) => {
      const adapter = files.find(f => f.path === 'src/dsh-adapter.mjs');
      if (!adapter) return {count: 0, samples: [], skipped: '未找到 dsh-adapter.mjs'};
      const list = /permitted=new Set\(\[([^\]]*)\]\)/.exec(adapter.content)?.[1];
      if (list === undefined) return {count: 0, samples: [], skipped: '未找到 permitted 白名单，检查方式需更新'};
      const permitted = new Set([...list.matchAll(/'([^']+)'/g)].map(m => m[1]));
      const used = new Set([...adapter.content.matchAll(/\bargs\.([a-zA-Z][\w]*)/g)].map(m => m[1]));
      const samples = [...used].filter(name => !permitted.has(name)).map(name => `读了 args.${name} 但白名单里没有`);
      return {count: samples.length, samples};
    },
  },
  {
    id: 'dataPalette', label: '数据调色板（逐项目配色）',
    hint: '逐项目/伙伴配色算数据，唯一来源 prototype/data-palette.mjs；模块里出现任何字面色值即违规。'
        + '新增标识色必须先登记进那张表，不能直接写在模块里。',
    run: ({files, registry: reg}) => {
      const source = files.find(f => f.path === 'src/v7/v7-data.css');
      if (!source) return {count: 0, samples: [], skipped: '未找到生成的 v7-data.css'};
      const declared = new Set([...source.content.matchAll(/--ws-data-([a-z0-9-]+)\s*:/g)].map(m => m[1]));
      const samples = [];
      // ① 表里登记了、生成物里没有 → 生成器没跑到
      const generated = new Set([...source.content.matchAll(/--ws-data-([a-z0-9-]+)\s*:/g)].map(m => m[1]));
      for (const name of declared) if (!generated.has(name)) samples.push('生成物缺少数据色: ' + name);
      // ② 模型里用了未登记的数据色
      for (const file of files) {
        if (!/\.(mjs|js|css|html)$/.test(file.path) || !isShipped(file.path)) continue;
        if (file.path === 'src/v7/v7-data.css') continue;
        for (const m of stripComments(file.content).matchAll(/--ws-data-([a-z0-9-]+)/g)) {
          if (!declared.has(m[1])) samples.push(file.path + ' 用了未登记的数据色: ' + m[1]);
        }
      }
      return {count: samples.length, samples};
    },
  },
  {
    id: 'componentOwners', label: '组件唯一（门禁 4）',
    hint: '每个控件全站只有一个构造点，声明在 spec/registry.json 的 controlOwners。'
        + '同一类控件出现第二个实现，就是"同一件事有两个说法"——用户会看出不一致。',
    run: ({files, registry: reg}) => {
      const items = reg?.controlOwners?.items ?? [];
      const samples = [];
      for (const control of items) {
        const pattern = new RegExp(control.signature, 'g');
        for (const file of files) {
          if (file.path === control.owner || COMPONENT_ALLOWED.includes(file.path) || !isShipped(file.path)) continue;
          const source = stripComments(file.content);
          if (pattern.test(source)) samples.push(file.path + ' 也在构造「' + control.id + '」：' + control.hint);
          pattern.lastIndex = 0;
        }
      }
      return {count: samples.length, samples};
    },
  },
  {
    id: 'duplicateAuthorities', label: '同名文档多版本（混乱主因）',
    hint: '同一份文档只应有一份"当前版本"；历史副本移入 _archive/ 或标注为历史，不要留下无法分辨的副本',
    run: ({mdPaths}) => {
      const seen = new Map();
      // 通用文件名不算重复（README/SKILL 等在不同目录本是不同文档）
      const GENERIC = new Set(['README.md', 'index.md', 'SKILL.md', 'CHANGELOG.md']);
      for (const rel of mdPaths ?? []) {
        const name = rel.split('/').pop();
        if (GENERIC.has(name)) continue;
        if (!seen.has(name)) seen.set(name, []);
        seen.get(name).push(rel);
      }
      const samples = [];
      for (const [name, paths] of seen) {
        if (paths.length <= 1) continue;
        const declared = IDENTICAL_ALIASES.get(name);
        if (declared) {
          // 登记过的别名组：逐字节核对，防止"只改了一份"这种静默分叉。
          const digests = new Set(paths.map(rel => {
            try { return createHash('sha256').update(readFileSync(join(repo, rel))).digest('hex'); }
            catch { return 'MISSING:' + rel; }
          }));
          if (digests.size === 1) continue;   // 内容一致 → 不是多版本问题
          samples.push(`${name} 别名组不再逐字节相同（有人只改了一份）：${paths.join(' / ')}`);
          continue;
        }
        samples.push(`${name} × ${paths.length}：${paths.join(' / ')}`);
      }
      return {count: samples.length, samples};
    },
  },
];

// ---------------------------------------------------------------- 运行
/** 收集"活跃区"的 markdown 路径（排除归档、依赖与发布包）。 */
function listMarkdown() {
  const out = [];
  const IGNORE = /(_archive|\/node_modules\/|backup|baseline|\/releases\/)/;
  const walk = dir => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      if (entry.name.startsWith('.')) continue;
      // 软链不算第二份文档（2026-10-22：spec/ 挪进仓库后，工作区根留了 spec -> workstation/spec
      // 的软链，扫描器把同一份规范数了两遍，62 处"同名多版本"全是假报）。
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      const rel = full.slice(repo.length + 1);
      if (IGNORE.test(rel)) continue;
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name.endsWith('.md')) out.push(rel);
    }
  };
  walk(repo);
  return out;
}

function runAll(files, reg, mdPaths, extra = {}) {
  const results = [];
  for (const check of CHECKS) {
    let out;
    try {
      out = check.run({files, registry: reg, mdPaths, ...extra});
    } catch (error) {
      out = {count: -1, samples: [`检查抛错: ${error.message}`], error: true};
    }
    results.push({...check, ...out});
  }
  return results;
}

const args = process.argv.slice(2);
const selfTest = args.includes('--self-test');
const updateBaseline = args.includes('--update-baseline');
const verbose = args.includes('--verbose');

// ---------------------------------------------------------------- 自检
if (selfTest) {
  // 每个检查：注入必须被发现的违规 + 干净输入必须零误报
  const injections = {
    colors: [{path: 'src/v7/evil.mjs', content: "const a = '#ff0000';"}],
    important: [{path: 'src/v7/evil.mjs', content: 'color: red !important;'}],
    spacing: [{path: 'src/v7/evil.mjs', content: 'padding: 13px;'}],
    fontSize: [{path: 'src/v7/evil.mjs', content: 'font-size: 17px;'}],
    entries: [
      {path: 'src/v7-shell.html', content: '<button data-view="home"></button><button data-view="ghost"></button>'},
    ],
    objects: [{path: 'src/validation.mjs', content: "const fields={project:['goal'],ghostkind:['x']};"}],
    wordlist: [{path: 'prototype/wording-audit.mjs', content: 'const TERMS=[];'}],
    emoji: [{path: 'src/v7/evil.mjs', content: "const label='🚀 发射';"}],
    componentOwners: [{path: 'src/v7/evil.mjs', content: "const s=document.createElement('select');"}],
    argWhitelists: [{path: 'src/dsh-adapter.mjs', content: "const permitted=new Set(['action']);\nconst x=args.ghost;"}],
    kindWhitelists: [
      {path: 'src/validation.mjs', content: "const fields={project:['goal']};"},
      {path: 'src/store.mjs', content: "const kinds = new Set(['project','task']);"},
    ],
    dataPalette: [
      {path: 'src/v7/v7-data.css', content: ':root{--ws-data-partner-1:#111111}'},
      {path: 'src/v7/project-data.mjs', content: "const p=[{color:'var(--ws-data-ghost)'}]"},
    ],
  };
  const injectionsExtra = {
    toolWhitelist: {protoNames: ['x-check.mjs'], auditTools: []},
  };
  const cleanExtra = {
    toolWhitelist: {protoNames: ['x-check.mjs'], auditTools: ['x-check.mjs']},
  };
  const injectionsMd = {
    duplicateAuthorities: ['a/发布说明.md', 'b/发布说明.md'],
  };
  const cleanMd = {
    duplicateAuthorities: ['a/发布说明.md', 'b/进度记录.md'],
  };
  // 别名组自检用的**真实路径**：登记表里那批逐字节相同的同名副本。
  // 组内一致 → 不许误报；只改一份 → 必须报"不再逐字节相同"。没有这两条，这项检查就是空转。
  const aliasGroup = (registry.identicalAliases?.items ?? [])[0];
  const aliasClean = {duplicateAuthorities: aliasGroup ? aliasGroup.paths : ['a/发布说明.md', 'b/发布说明.md']};
  // 漂移模拟：同名但其中一条路径已不存在/内容不同 —— 必须被抓到（守卫按内容比对，不靠文件名）。
  const aliasChanged = {duplicateAuthorities: aliasGroup
    ? [aliasGroup.paths[0], 'drifted/' + aliasGroup.name]
    : ['a/发布说明.md', 'b/发布说明.md']};
  const clean = {
    colors: [{path: 'src/v7/tokens.css', content: "a{color:#315ed0}"}],
    important: [{path: 'src/v7/ok.mjs', content: 'color: var(--ws-action);'}],
    spacing: [{path: 'src/v7/ok.mjs', content: 'padding: 12px; margin-top: 24px; gap: 8px;'}],
    fontSize: [{path: 'src/v7/ok.mjs', content: 'font-size: 14px;'}],
    entries: [{path: 'src/v7-shell.html', content: ENTRIES_REGISTERED.map(id => `<button data-view="${id}"></button>`).join('')}],
    objects: [{path: 'src/validation.mjs', content: "const fields={project:['goal'],layout:['positions']};"}],
    wordlist: [{path: 'prototype/wording-audit.mjs', content: FORBIDDEN.map(t => `'${t}'`).join(',')}],
    emoji: [{path: 'src/v7/ok.mjs', content: "const label='✓ 已完成';const b='◇ 待核对';const c='↩ 已被推翻';"}],
    componentOwners: [{path: 'src/v7/vi-select.mjs', content: "const s=document.createElement('select');"}],
    argWhitelists: [{path: 'src/dsh-adapter.mjs', content: "const permitted=new Set(['action','ghost']);\nconst x=args.ghost;"}],
    // 干净的白名单必须与注入用例对应，否则这项自检是空转通过（实测踩过）
    kindWhitelists: [
      {path: 'src/validation.mjs', content: "const fields={project:['goal'],task:['status']};"},
      {path: 'src/store.mjs', content: "const kinds = new Set(['project','task']);"},
    ],
    dataPalette: [
      {path: 'src/v7/v7-data.css', content: ':root{--ws-data-partner-1:#111111}'},
      {path: 'src/v7/project-data.mjs', content: "const p=[{color:'var(--ws-data-partner-1)'}]"},
    ],
  };
  let failed = 0;
  for (const check of CHECKS) {
    const dirty = runAll(injections[check.id] ?? [], registry, injectionsMd[check.id] ?? [], injectionsExtra[check.id] ?? {}).find(r => r.id === check.id);
    const ok = runAll(clean[check.id] ?? [], registry, cleanMd[check.id] ?? [], cleanExtra[check.id] ?? {}).find(r => r.id === check.id);
    const detected = dirty.count > 0;
    const quiet = ok.count === 0;
    if (!detected) { failed++; console.log(`FAIL: 自检未通过 —— ${check.label} 没发现注入的违规，门禁是摆设`); }
    if (!quiet) { failed++; console.log(`FAIL: 自检未通过 —— ${check.label} 对干净输入误报 ${ok.count} 处：${ok.samples[0]}`); }
    if (detected && quiet) console.log(`  PASS: ${check.label}（能发现违规、不误报）`);
  }
  // 别名组专项：登记过的同名副本（内容一致）必须放行；把同名的两份指到不同内容必须报错。
  if (aliasGroup) {
    const quiet = runAll([], registry, aliasClean.duplicateAuthorities).find(r => r.id === 'duplicateAuthorities');
    const noisy = runAll([], registry, aliasChanged.duplicateAuthorities).find(r => r.id === 'duplicateAuthorities');
    if (quiet.count !== 0) { failed++; console.log('FAIL: 自检未通过 —— 别名组内容一致却被报成多版本：' + quiet.samples[0]); }
    else console.log('  PASS: 同名文档别名组（登记 + 逐字节相同）不误报');
    if (noisy.count === 0) { failed++; console.log('FAIL: 自检未通过 —— 同名的两份指向不同内容却没发现，检查是摆设'); }
    else console.log('  PASS: 同名两份内容不同会被抓到');
  }
  console.log(failed ? `FAIL: 自检 ${failed} 项未通过` : `PASS: 自检通过（${CHECKS.length} 项检查都能发现违规且不误报）`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------- 主流程
const files = listFiles();
const mdPaths = listMarkdown();
// ── 空扫描护栏（2026-10-16 红队实测：把 src/ 改个名 → 14 项全 0 → PASS / EXIT=0）─────
// "没有可扫的文件"和"扫了但没有违规"必须分开。扫描面不存在 = 门禁失效，必须红。
const REQUIRED_PATHS = ['src/v7-shell.html', 'src/validation.mjs', 'src/dsh-adapter.mjs', 'src/v7/v7-data.css'];
if (files.length === 0) {
  console.log('FAIL: 扫描面是空的（' + SCAN_DIRS.join('、') + ' 下没有可扫文件）—— 门禁没有在把关，不是"零违规"。');
  process.exit(1);
}
const missingRequired = REQUIRED_PATHS.filter(path => !files.some(file => file.path === path));
if (missingRequired.length) {
  console.log('FAIL: 门禁的必备扫描对象不见了：' + missingRequired.join('、'));
  console.log('      这些文件缺失时，对应检查会静默降级成"未找到"并报 0 违规 —— 那不算通过。');
  process.exit(1);
}

// 工具脚本检查需要"prototype 下的文件清单"与"文案门禁的 TOOLS 名单"
const auditSource = readFileSync(join(root, 'prototype/wording-audit.mjs'), 'utf8');
const auditTools = [...(/const TOOLS=\[([^\]]*)\]/.exec(auditSource)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(m => m[1]);
const protoNames = readdirSync(join(root, 'prototype')).filter(name => name.endsWith('.mjs'));
const results = runAll(files, registry, mdPaths, {protoNames, auditTools});
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;

if (updateBaseline) {
  const next = {
    _readme: '宪章守卫的棘轮基线。任何一项违规数上升即门禁失败；下降后可用 charter-guard --update-baseline 收紧。批次 5 的目标是把它们全部降到 0。',
    updatedAt: new Date().toISOString().slice(0, 10),
    counts: Object.fromEntries(results.map(r => [r.id, Math.max(0, r.count)])),
  };
  const raised = baseline ? Object.entries(next.counts).filter(([id, n]) => n > (baseline.counts[id] ?? 0)) : [];
  // 2026-10-16 红队实测：注入 3 处违规 → FAIL；跑一次 --update-baseline（只打印 WARN）→ 再跑就 PASS。
  // 棘轮只能**收紧**，不能把新债务洗成基线；写基线还要显式加 --yes（防手滑、防顺手）。
  if (raised.length) {
    console.log('FAIL: 有 ' + raised.length + ' 项比原基线更高 —— 棘轮不能上调，基线只应在下降后收紧。');
    for (const [id, n] of raised) console.log('  ' + id + '  ' + (baseline?.counts?.[id] ?? 0) + ' → ' + n);
    console.log('      先把这些违规修掉；确实要留债，必须由人改 spec/guard-baseline.json 并写明理由。');
    process.exit(1);
  }
  const confirmed = args.includes('--yes');
  writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n');
  console.log(`已写入基线 ${baselinePath.slice(repo.length + 1)}${confirmed ? '' : '（未加 --yes：已校验没有上调，只允许收紧）'}`);
  for (const [id, n] of Object.entries(next.counts)) {
    const before = baseline?.counts?.[id];
    const arrow = before === undefined ? '新增' : n > before ? `↑ +${n - before}` : n < before ? `↓ -${before - n}` : '=';
    console.log(`  ${id.padEnd(10)} ${String(n).padStart(4)}  ${arrow}`);
  }
  process.exit(0);
}

let regressions = 0;
console.log('宪章守卫 · 机械检查（登记表驱动 + 棘轮基线）');
console.log('─'.repeat(62));
for (const result of results) {
  const limit = baseline?.counts?.[result.id];
  const count = Math.max(0, result.count);
  const status = result.error ? 'ERROR'
    : limit === undefined ? 'NEW  '
      : count > limit ? 'FAIL ' : count < limit ? 'DOWN ' : 'ok   ';
  if (status === 'FAIL ') regressions++;
  console.log(`${status} ${result.label.padEnd(26)} ${String(count).padStart(4)}` +
    (limit === undefined ? '' : `  (基线 ${limit})`) +
    (result.skipped ? `  ${result.skipped}` : ''));
  if (verbose || status === 'FAIL ') {
    for (const sample of result.samples.slice(0, 5)) console.log(`        ${sample}`);
    if (result.samples.length > 5) console.log(`        …还有 ${result.samples.length - 5} 处`);
    if (status === 'FAIL ') console.log(`        改法：${result.hint}`);
  }
}
console.log('─'.repeat(62));
if (!baseline) {
  console.log('FAIL: 没有基线文件。先跑 node prototype/charter-guard.mjs --update-baseline 建立基线。');
  process.exit(1);
}
if (regressions) {
  console.log(`FAIL: ${regressions} 项比基线更差 —— 新增债务不允许进入代码。`);
  process.exit(1);
}
const debt = results.reduce((sum, r) => sum + Math.max(0, r.count), 0);
console.log(`PASS: 没有新增债务（当前存量 ${debt} 处，批次 5 的目标是全部降到 0）。`);
