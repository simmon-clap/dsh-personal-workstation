#!/usr/bin/env node
/**
 * 共享组件签名审计（离线 · 只读）
 *
 * 依据：spec/54 §4「共享组件与门禁」/ spec/53 §3.4 / spec/02 VI §6 / spec/48 S6·S7 / spec/17 C5
 * 规范：spec/56-共享组件与差异规范-v1.0-20261021.md（B0）
 *
 * 它只回答一个问题：**同一件事是不是只有一套实现**。
 * 默认扫描 prototype/*.mjs 与 prototype/*.css（只读，不改任何文件）；
 * 详情弹窗宽度是特例：契约值 760 定义在 prototype/v7-shell.html 的外壳样式里，
 * 所以规则 2 额外只读这**一个** shell 契约文件来核对 760，其余 HTML 不扫。
 *
 * 退出码：任一规则出现「已违例 / 未登记」→ 1；全部 PASS → 0。
 * 这不是「可以为了绿而放宽」的门禁：扫描范围内真实存在的第二个实现会一直红，
 * 直到 B1/B2/B3/A2 按 spec/56 把它收口。已知历史债务会标 category=pending-rework
 * 并给出 expectedFix（修复批次）；新出现的漂移标 category=violation；登记缺失标 unregistered。
 *
 * 用法：
 *   node prototype/component-signature-audit.mjs            # 人读输出
 *   node prototype/component-signature-audit.mjs --json     # 机器读（纯 JSON）
 *   node prototype/component-signature-audit.mjs --self-test# 内存假文件表 canary
 *   node prototype/component-signature-audit.mjs --help
 */
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {dirname, join, resolve, basename} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

/** 详情弹窗唯一宽度契约（VI §4 / VI §6；spec/registry.json contractValues）。 */
export const DIALOG_WIDTH_CONTRACT = 760;
/** 弹窗唯一实现（coordinator）。 */
export const DIALOG_OWNER = 'prototype/modal.mjs';
/** 撤销反馈唯一实现（左下「已保存 · 撤销」）。 */
export const UNDO_OWNER = 'prototype/batch.mjs';
/** 空态唯一实现。 */
export const EMPTY_OWNER = 'prototype/empty-state.mjs';
/** 状态点唯一定义文件。 */
export const STATUS_DOT_OWNER = 'prototype/v7-workbench.css';
/** 全站唯一筛选条实现。 */
export const FILTER_OWNER = 'prototype/project-view.mjs';
/** 画布紧凑卡登记位置。 */
export const CARD_COMPONENT_ID = 'card';
export const CANVAS_VARIANT = 'canvasNode';

/**
 * 已知历史债务：B0 只登记、不在本批修；B1/B2/B3/A2/B4 收口。
 * 命中这里的违例会标 category=pending-rework（仍然退出码 1，不隐藏债务）；
 * 不在这里的违例标 category=violation（新漂移，应先停手报告）。
 * key = 规则 id :: 文件路径（宽度规则再带 ::像素值，避免同文件新增宽度被误归为旧债）。
 */
export const KNOWN_DEBT = [
  // 2026-10-21 B1/B3 收口后为空：冻结外壳的 510 死声明在生成期收敛成 760；收件箱自造空态改走 empty-state.mjs。
  // 规则与 canary 不变——出现新的第二实现仍然必红（见 test/component-signature.test.mjs）。
];

/** 七条规则的元信息：id / 标题 / 要求 / 违例样本（self-test 与文档共用）。 */
export const RULES = [
  {
    id: 'dialog-unique',
    title: '弹窗唯一实现',
    requirement: '除 modal.mjs 外，任何模块不得自己创建遮罩弹窗（className/class 含 veil、手写 overlay、自建 role=dialog 外壳）。',
    violationSample: `<div class="veil" role="dialog">…</div> 或 veil.className='cmdk-veil'`,
    source: 'spec/02 VI §6 · spec/48 S6/S7 · spec/54 §4',
  },
  {
    id: 'dialog-width',
    title: '弹窗宽度唯一',
    requirement: `全站详情弹窗只允许 ${DIALOG_WIDTH_CONTRACT}px 一个宽度值；不得出现 720/520/560 等第二个宽度。`,
    violationSample: `.modal{width:720px}`,
    source: 'spec/02 VI §4/§6 · spec/48 S7 · spec/54 §4',
  },
  {
    id: 'undo-feedback',
    title: '撤销/反馈唯一',
    requirement: '只允许一处生成「已保存 · 撤销」反馈条（batch.mjs）；其他模块通过它反馈，不得自建。',
    violationSample: `label.textContent='已保存 · '; bar.id='undobar'`,
    source: 'spec/02 VI §6/§7 · spec/48 S7 · spec/54 §4',
  },
  {
    id: 'empty-state',
    title: '空态唯一',
    requirement: '只允许 empty-state.mjs 渲染空态结构（简笔画 + 一句状态 + 一个下一步）；其他模块不得自造 .v7-empty/插画空态。',
    violationSample: `<div class="v7-empty"><img src="…/illustrations/empty.svg"></div>`,
    source: 'spec/02 VI §6 · spec/17 C5 · spec/48 S4 · spec/54 §4',
  },
  {
    id: 'status-dot',
    title: '状态点唯一',
    requirement: '.statusdot 家族只允许一处 CSS 定义（v7-workbench.css 的 data-state 变量表）；第二个文件定义即违例。',
    violationSample: '.statusdot{width:8px}（出现在第二个 CSS 文件）',
    source: 'spec/02 VI §7 · spec/48 S6 · spec/54 §4',
  },
  {
    id: 'filter-bar',
    title: '筛选唯一',
    requirement: '只允许一处 filterBarHtml 实现（project-view.mjs）；项目/任务/收件箱都必须 import 它。',
    violationSample: 'export function filterBarHtml(){…}（出现在 project-view.mjs 之外）',
    source: 'spec/17 C4 · spec/48 S6 · spec/54 §3.1/§4',
  },
  {
    id: 'card-shell',
    title: '卡片外壳只有一个来源',
    requirement: '卡片密度标记（data-density）只能由 prototype/card.mjs 产出；项目卡 / 任务卡（看板与行式）/ 收件箱卡的外壳必须 import 它，不得各自手写外壳或密度。',
    violationSample: '<button class="taskrow" data-density="standard">（手写外壳与密度，绕过 card.mjs）',
    source: 'spec/54 §3.1/§4 · spec/56 §1 · spec/registry.json components.card',
  },
  {
    id: 'canvas-node-variant',
    title: '画布节点密度变体已登记',
    requirement: 'spec/registry.json 的 components.card.variants 必须包含 canvasNode（页面标准档 + 画布紧凑档，同一实现两档密度）。缺失 = 未登记。',
    violationSample: `components.card.variants = ["record","advice","judgment"]（缺 canvasNode）`,
    source: 'spec/54 §3.1/§4 · spec/53 §2.2 · spec/registry.json',
  },
];

const RULE_BY_ID = new Map(RULES.map(rule => [rule.id, rule]));

/** 登记表里登记过的浮层控件（controlOwners.kind === 'overlay-panel'）。
 *  命令面板这类**独立浮层**与详情弹窗不是同一个控件：它登记后就不算「第二套弹窗」，
 *  但未登记的第三套遮罩仍然必红（canary 钉住）。owner 两套路径都认：发布层 src/v7/x.mjs ↔ 源文件 prototype/x.mjs。 */
export function registeredOverlays(registry) {
  const items = Array.isArray(registry?.controlOwners?.items) ? registry.controlOwners.items : [];
  return items.filter(item => item && item.kind === 'overlay-panel' && typeof item.owner === 'string').map(item => {
    const name = item.owner.split('/').pop();
    return {id: item.id, name, sources: ['prototype/' + name, 'src/v7/' + name]};
  });
}
export function overlayOwnerPaths(registry) {
  return new Set(registeredOverlays(registry).flatMap(overlay => overlay.sources));
}
/** 已登记控件的宽度契约（按 surface 选择器匹配；未登记的第二个宽度仍然必红）。 */
export function registeredWidths(registry) {
  const items = Array.isArray(registry?.controlOwners?.items) ? registry.controlOwners.items : [];
  return items.filter(item => item && typeof item.surface === 'string' && Number.isFinite(item.width)).map(item => {
    let matcher = null;
    try { matcher = new RegExp(item.surface); } catch { matcher = null; }
    return {id: item.id, width: Number(item.width), matcher};
  });
}

// ── 通用工具 ────────────────────────────────────────────────────────────────

/** 一行一行地算行号（0 基索引 → 1 基行号）。 */
export function lineAt(text, index) {
  let line = 1;
  for (let position = 0; position < index && position < text.length; position += 1) {
    if (text[position] === '\n') line += 1;
  }
  return line;
}

/** 原文某行去掉行号后的片段（用于输出证据）。 */
export function lineSnippet(text, line, limit = 190) {
  const row = String(text).split('\n')[line - 1] ?? '';
  const trimmed = row.trim().replace(/\s+/g, ' ');
  return trimmed.length > limit ? trimmed.slice(0, limit) + '…' : trimmed;
}

/** 命中点在行内的列号（0 基）。 */
export function columnAt(text, index) {
  const lineStart = String(text).lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  return Math.max(0, index - lineStart);
}

/** 以「行 + 列」取证据：外壳样式是单行巨型 CSS，取行首什么都看不出来。 */
export function snippetAt(text, line, column, radius = 90) {
  const row = (String(text).split('\n')[line - 1] ?? '');
  if (!row) return '';
  const at = Math.max(0, Math.min(column, Math.max(0, row.length - 1)));
  const start = Math.max(0, at - radius);
  const end = Math.min(row.length, at + radius);
  let snippet = row.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snippet = '…' + snippet;
  if (end < row.length) snippet = snippet + '…';
  return snippet;
}

/** 兼容旧调用：index 取自同一段文本时直接取行/列。 */
export function snippetAround(text, index, radius = 90) {
  return snippetAt(text, lineAt(text, index), columnAt(text, index), radius);
}

/**
 * 去掉 JS 注释但**保留换行数**，这样剥离后的行号与原文件一致。
 * 字符串/模板字符串保持原样（HTML 片段就在模板里，必须还能被规则看见）。
 */
export function stripJsComments(source) {
  const text = String(source ?? '');
  let output = '';
  let index = 0;
  let state = 'code';
  let quote = '';
  while (index < text.length) {
    const char = text[index];
    if (state === 'code') {
      if (char === '/' && text[index + 1] === '/') { state = 'line'; index += 2; continue; }
      if (char === '/' && text[index + 1] === '*') { state = 'block'; index += 2; continue; }
      if (char === "'" || char === '"' || char === '`') { state = 'string'; quote = char; output += char; index += 1; continue; }
      output += char; index += 1; continue;
    }
    if (state === 'line') {
      if (char === '\n') { state = 'code'; output += char; }
      index += 1; continue;
    }
    if (state === 'block') {
      if (char === '*' && text[index + 1] === '/') { state = 'code'; index += 2; continue; }
      if (char === '\n') output += '\n';
      index += 1; continue;
    }
    // string / template：整体保留，避免把字符串里的 // 当注释
    output += char;
    if (char === '\\') { output += text[index + 1] ?? ''; index += 2; continue; }
    if (char === quote) state = 'code';
    index += 1;
  }
  return output;
}

const toFinding = ({path, line, snippet, category = 'violation', note = '', expectedFix = null, value = null}) => {
  const finding = {path, line, snippet, category, note};
  if (expectedFix) finding.expectedFix = expectedFix;
  if (value !== null) finding.value = value;
  return finding;
};

const debtFor = (ruleId, path, value = null) => {
  const candidates = [value === null ? null : `${path}::${value}`, path].filter(Boolean);
  return KNOWN_DEBT.find(entry => entry.ruleId === ruleId && candidates.includes(entry.key)) ?? null;
};

/** 给一条原始违例补上「历史债务 / 新漂移」分类。 */
const classify = (ruleId, finding) => {
  const debt = debtFor(ruleId, finding.path, finding.value);
  if (!debt) return finding;
  return {...finding, category: 'pending-rework', expectedFix: debt.expectedFix, note: [finding.note, debt.note].filter(Boolean).join('；')};
};

/** 只读 JS：返回 [{path, content, stripped}]；审计脚本自己不计入。 */
const jsTable = files => files
  .filter(file => file.path.endsWith('.mjs') && !file.path.endsWith('component-signature-audit.mjs'))
  .map(file => ({path: file.path, content: file.content, stripped: stripJsComments(file.content)}));

const cssTable = files => files.filter(file => file.path.endsWith('.css'));

/** 逐个 CSS 规则（selector{body}）迭代；返回选择器与 body 在原文中的绝对偏移。 */
function cssRules(text) {
  const rules = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = pattern.exec(text))) {
    const braceOffset = match[0].indexOf('{');
    rules.push({
      selector: match[1].trim(),
      body: match[2],
      selectorIndex: match.index,
      bodyIndex: match.index + braceOffset + 1,
    });
  }
  return rules;
}

const DIALOG_SELECTOR = /(?:^|[\s,>+~])(?:\.drawer|\.modal|\.veil|\.cmdk)(?=$|[\s,:[.#>+~])/;

// ── 规则 1：弹窗唯一实现 ────────────────────────────────────────────────────

const OVERLAY_CLASS = /\bclass(?:Name)?\s*=\s*['"][^'"]*(?:veil|overlay|backdrop)[^'"]*['"]/g;
const OVERLAY_CLASS_SET = /\.className\s*=\s*['"][^'"]*(?:veil|overlay|backdrop)[^'"]*['"]|\bsetAttribute\(\s*['"]class['"]\s*,\s*['"][^'"]*(?:veil|overlay|backdrop)[^'"]*['"]|\bclassList\.(?:add|toggle)\(\s*['"][^'"]*(?:veil|overlay|backdrop)[^'"]*['"]/g;
const OVERLAY_ID = /\bid\s*=\s*['"](?:veil|overlay|backdrop)['"]/g;

export function scanDialogUnique({files, registry = null}) {
  const findings = [];
  const overlayOwners = overlayOwnerPaths(registry);
  for (const file of jsTable(files)) {
    if (file.path === DIALOG_OWNER) continue;
    if (overlayOwners.has(file.path)) continue;   // 已登记的独立浮层（如命令面板）不是详情弹窗的第二套实现
    const matches = [];
    for (const pattern of [OVERLAY_CLASS, OVERLAY_CLASS_SET, OVERLAY_ID]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(file.stripped))) matches.push(match.index + (match[0].indexOf('class') >= 0 ? 0 : 0));
    }
    if (!matches.length) continue;
    const unique = [...new Set(matches)].sort((a, b) => a - b);
    const lines = [...new Set(unique.map(index => lineAt(file.stripped, index)))].sort((a, b) => a - b);
    findings.push(toFinding({
      path: file.path,
      line: lines[0],
      snippet: snippetAt(file.content, lines[0], columnAt(file.stripped, unique[0])),
      note: `第二套遮罩弹窗（命中 ${lines.length} 行${lines.length > 1 ? '：第 ' + lines.join('、') + ' 行' : ''}）；应走 ${DIALOG_OWNER}`,
    }));
  }
  return findings.map(finding => classify('dialog-unique', finding));
}

// ── 规则 2：弹窗宽度唯一 ────────────────────────────────────────────────────

const WIDTH_DECLARATION = /(?<![-\w])width\s*:\s*(?:min\(\s*)?(\d{2,4})px/g;

export function scanDialogWidth({files, shellFiles = [], registry = null}) {
  const allowedWidths = registeredWidths(registry);
  const isRegisteredWidth = (selector, value) => allowedWidths.some(entry => entry.width === value && entry.matcher && entry.matcher.test(selector));
  const scanned = [...cssTable(files), ...shellFiles.filter(file => file.path.endsWith('.html'))];
  const findings = [];
  const seen = new Set();
  let contractSeen = false;
  let contractPath = shellFiles.find(file => file.path.endsWith('.html'))?.path ?? null;

  for (const file of scanned) {
    for (const rule of cssRules(file.content)) {
      if (!DIALOG_SELECTOR.test(rule.selector)) continue;
      WIDTH_DECLARATION.lastIndex = 0;
      let match;
      while ((match = WIDTH_DECLARATION.exec(rule.body))) {
        const value = Number(match[1]);
        // 只把弹窗量级（400–1000px）当宽度；图标/内联控件的 px 不参与。
        if (!Number.isFinite(value) || value < 400 || value > 1000) continue;
        if (value === DIALOG_WIDTH_CONTRACT) { contractSeen = true; continue; }
        // 已登记的独立浮层控件（registry.controlOwners 的 surface + width）在它自己的选择器上允许一个不同的宽度。
        if (isRegisteredWidth(rule.selector, value)) continue;
        const index = rule.bodyIndex + match.index;
        const line = lineAt(file.content, index);
        const key = `${file.path}::${line}::${value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push(toFinding({
          path: file.path,
          line,
          snippet: snippetAt(file.content, line, columnAt(file.content, index)),
          value,
          note: `详情弹窗出现第二个宽度 ${value}px（契约值只有 ${DIALOG_WIDTH_CONTRACT}px）`,
        }));
      }
    }
  }
  if (!contractSeen) {
    findings.push(toFinding({
      path: contractPath ?? 'prototype/v7-shell.html',
      line: 0,
      snippet: '未找到 .drawer/.modal 的 width:760px',
      category: 'unregistered',
      note: `未登记/未找到详情弹窗宽度契约值 ${DIALOG_WIDTH_CONTRACT}px：先确认外壳 .drawer 仍是 760`,
    }));
  }
  return findings.map(finding => classify('dialog-width', finding));
}

// ── 规则 3：撤销/反馈唯一 ───────────────────────────────────────────────────

const UNDO_TEXT = /textContent\s*=\s*['"]已保存\s*·/g;
const UNDO_BAR = /\bid\s*=\s*['"]undobar['"]|\bdata-undotext\b|\bclass(?:Name)?\s*=\s*['"]undobar['"]/g;

export function scanUndoFeedback({files}) {
  const findings = [];
  for (const file of jsTable(files)) {
    const hits = [];
    for (const pattern of [UNDO_TEXT, UNDO_BAR]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(file.stripped))) hits.push(match.index);
    }
    if (!hits.length) continue;
    if (file.path === UNDO_OWNER) continue;
    const line = lineAt(file.stripped, Math.min(...hits));
    findings.push(toFinding({
      path: file.path,
      line,
      snippet: snippetAt(file.content, line, columnAt(file.stripped, Math.min(...hits))),
      note: `第二处生成「已保存 · 撤销」反馈条；唯一实现应在 ${UNDO_OWNER}`,
    }));
  }
  const owner = jsTable(files).find(file => file.path === UNDO_OWNER);
  if (!owner || (!UNDO_TEXT.test(owner.stripped) && !UNDO_BAR.test(owner.stripped))) {
    findings.push(toFinding({
      path: UNDO_OWNER,
      line: 0,
      snippet: '（未找到撤销反馈实现）',
      category: 'unregistered',
      note: '撤销反馈的唯一实现缺失：用户自己做的改动没有「已保存 · 撤销」条',
    }));
  }
  return findings.map(finding => classify('undo-feedback', finding));
}

// ── 规则 4：空态唯一 ────────────────────────────────────────────────────────

const EMPTY_STRUCT = /\bclass(?:Name)?\s*=\s*['"][^'"]*v7-empty|\bclassList\.(?:add|toggle)\(\s*['"]v7-empty|<[a-z]+\s[^>]*class=["'][^"']*v7-empty/g;
const EMPTY_ASSET = /\bassets\/illustrations\/[a-z-]+\.svg/g;

export function scanEmptyStates({files}) {
  const findings = [];
  for (const file of jsTable(files)) {
    if (file.path === EMPTY_OWNER) continue;
    const structure = [];
    const assets = [];
    EMPTY_STRUCT.lastIndex = 0;
    let match;
    while ((match = EMPTY_STRUCT.exec(file.stripped))) structure.push(match.index);
    EMPTY_ASSET.lastIndex = 0;
    while ((match = EMPTY_ASSET.exec(file.stripped))) assets.push(match.index);
    if (!structure.length && !assets.length) continue;
    const index = structure.length ? Math.min(...structure) : Math.min(...assets);
    const line = lineAt(file.stripped, index);
    findings.push(toFinding({
      path: file.path,
      line,
      snippet: snippetAt(file.content, line, columnAt(file.stripped, index)),
      note: `自造空态结构${assets.length ? '（直接引用简笔画资源）' : ''}；唯一实现应在 ${EMPTY_OWNER}`,
    }));
  }
  return findings.map(finding => classify('empty-state', finding));
}

// ── 规则 5：状态点唯一 ──────────────────────────────────────────────────────

const STATUS_DOT_DEF = /\.statusdot(?=$|[\s,{:[.#>+~])/g;

export function scanStatusDot({files}) {
  const findings = [];
  for (const file of cssTable(files)) {
    if (file.path === STATUS_DOT_OWNER) continue;
    STATUS_DOT_DEF.lastIndex = 0;
    const match = STATUS_DOT_DEF.exec(file.content);
    if (!match) continue;
    const line = lineAt(file.content, match.index);
    findings.push(toFinding({
      path: file.path,
      line,
      snippet: snippetAt(file.content, line, columnAt(file.content, match.index)),
      note: `.statusdot 在第二个 CSS 文件定义；唯一来源应在 ${STATUS_DOT_OWNER}`,
    }));
  }
  const owner = cssTable(files).find(file => file.path === STATUS_DOT_OWNER);
  if (!owner || !/\.statusdot(?=$|[\s,{:[.#>+~])/.test(owner.content)) {
    findings.push(toFinding({
      path: STATUS_DOT_OWNER,
      line: 0,
      snippet: '（未找到 .statusdot 定义）',
      category: 'unregistered',
      note: '状态点唯一定义缺失：卡片/筛选片会各自发明色点',
    }));
  }
  return findings.map(finding => classify('status-dot', finding));
}

// ── 规则 6：筛选唯一 ────────────────────────────────────────────────────────

const FILTER_DEF = /(?:export\s+)?function\s+filterBarHtml\s*\(|(?:const|let|var)\s+filterBarHtml\s*=/g;

export function scanFilterBar({files}) {
  const findings = [];
  for (const file of jsTable(files)) {
    if (file.path === FILTER_OWNER) continue;
    FILTER_DEF.lastIndex = 0;
    const match = FILTER_DEF.exec(file.stripped);
    if (!match) continue;
    const line = lineAt(file.stripped, match.index);
    findings.push(toFinding({
      path: file.path,
      line,
      snippet: snippetAt(file.content, line, columnAt(file.stripped, match.index)),
      note: `第二处 filterBarHtml 实现；唯一实现应在 ${FILTER_OWNER}`,
    }));
  }
  const owner = jsTable(files).find(file => file.path === FILTER_OWNER);
  if (!owner || !FILTER_DEF.test(owner.stripped)) {
    findings.push(toFinding({
      path: FILTER_OWNER,
      line: 0,
      snippet: '（未找到 filterBarHtml 实现）',
      category: 'unregistered',
      note: '全站唯一筛选条实现缺失',
    }));
  }
  return findings.map(finding => classify('filter-bar', finding));
}

// ── 规则 8：卡片外壳只有一个来源 ─────────────────────────────────────────────

/** 卡片外壳与密度只允许 card.mjs 产出：其他地方出现 data-density 字面量就是第二套外壳。 */
export const CARD_SHELL_OWNER = 'prototype/card.mjs';
/** 必须使用 card.mjs 外壳的四个卡片渲染处（少一个就是没接上外壳）。 */
export const CARD_SHELL_CONSUMERS = ['prototype/project-render.mjs', 'prototype/task-render.mjs', 'prototype/task-view.mjs', 'prototype/inbox.mjs'];

export function scanCardShell({files}) {
  const findings = [];
  for (const file of jsTable(files)) {
    if (file.path === CARD_SHELL_OWNER) continue;
    const hits = [];
    const pattern = /data-density\s*=\s*['"]/g;
    let match;
    while ((match = pattern.exec(file.stripped))) hits.push(match.index);
    if (!hits.length) continue;
    const lines = [...new Set(hits.map(index => lineAt(file.stripped, index)))].sort((a, b) => a - b);
    findings.push(toFinding({
      path: file.path,
      line: lines[0],
      snippet: snippetAt(file.content, lines[0], columnAt(file.stripped, hits[0])),
      note: '手写卡片密度标记（应走 prototype/card.mjs 的 cardOpen/cardDensityAttr）',
    }));
  }
  // 四个渲染处都必须真的 import card.mjs（否则"统一外壳"名存实亡）。
  for (const path of CARD_SHELL_CONSUMERS) {
    const file = jsTable(files).find(item => item.path === path);
    if (!file) {
      findings.push(toFinding({path, line: 0, snippet: '文件缺失', note: '卡片渲染处不在扫描范围里', category: 'unregistered'}));
      continue;
    }
    if (!/from\s+'\.\/card\.mjs'/.test(file.content)) {
      findings.push(toFinding({path, line: 0, snippet: "缺 import './card.mjs'", note: '这个卡片渲染处没有使用唯一的外壳实现', category: 'unregistered'}));
    }
  }
  return findings.map(finding => finding.category ? finding : classify('card-shell', finding));
}

// ── 规则 7：画布节点密度变体已登记 ──────────────────────────────────────────

export function scanCanvasVariant({registry, registryPath = 'spec/registry.json'}) {
  if (!registry || typeof registry !== 'object' || registry.error) {
    return [{
      path: registryPath,
      line: 0,
      snippet: registry?.error ? `registry 读取失败：${registry.error}` : 'registry 不可用',
      category: 'unregistered',
      note: '未登记：读不到 registry，无法确认画布紧凑卡变体（脚本不应因此崩溃）',
      expectedFix: 'A0',
    }];
  }
  const items = registry?.components?.items;
  if (!Array.isArray(items)) {
    return [{path: registryPath, line: 0, snippet: 'components.items 缺失', category: 'unregistered', note: '未登记：registry 结构里没有 components.items', expectedFix: 'A0'}];
  }
  const card = items.find(item => item?.id === CARD_COMPONENT_ID);
  if (!card) {
    return [{path: registryPath, line: 0, snippet: '未找到 components.card', category: 'unregistered', note: '未登记：卡片组件本体不在 registry 里', expectedFix: 'A0'}];
  }
  const variants = Array.isArray(card.variants) ? card.variants : [];
  if (!variants.includes(CANVAS_VARIANT)) {
    return [{
      path: registryPath,
      line: 0,
      snippet: `components.card.variants = ${JSON.stringify(variants)}`,
      category: 'unregistered',
      note: `未登记：画布紧凑卡变体 ${CANVAS_VARIANT} 不在 components.card.variants 里（登记前此项预期会红）`,
      expectedFix: 'A0',
    }];
  }
  return [];
}

// ── 编排 / 输出 ─────────────────────────────────────────────────────────────

const RULE_SCANNERS = {
  'dialog-unique': scanDialogUnique,
  'dialog-width': scanDialogWidth,
  'undo-feedback': scanUndoFeedback,
  'empty-state': scanEmptyStates,
  'status-dot': scanStatusDot,
  'filter-bar': scanFilterBar,
  'card-shell': scanCardShell,
  'canvas-node-variant': scanCanvasVariant,
};

/** 跑 7 条规则。输入是内存文件表，纯函数，不碰磁盘（CLI 负责读盘）。 */
export function runRules({files = [], shellFiles = [], registry = null, registryPath = 'spec/registry.json'} = {}) {
  const rules = RULES.map(meta => {
    const findings = RULE_SCANNERS[meta.id]({files, shellFiles, registry, registryPath}) ?? [];
    const categorized = findings.map(finding => {
      const category = ['unregistered', 'pending-rework', 'violation'].includes(finding.category) ? finding.category : 'violation';
      return {...finding, category};
    });
    return {
      id: meta.id,
      title: meta.title,
      requirement: meta.requirement,
      violationSample: meta.violationSample,
      source: meta.source,
      status: categorized.length ? 'fail' : 'pass',
      findings: categorized,
    };
  });
  const findings = rules.flatMap(rule => rule.findings);
  const summary = {
    rules: rules.length,
    pass: rules.filter(rule => rule.status === 'pass').length,
    fail: rules.filter(rule => rule.status === 'fail').length,
    findings: findings.length,
    pendingRework: findings.filter(finding => finding.category === 'pending-rework').length,
    violations: findings.filter(finding => finding.category === 'violation').length,
    unregistered: findings.filter(finding => finding.category === 'unregistered').length,
  };
  return {ok: summary.fail === 0, exitCode: summary.fail === 0 ? 0 : 1, summary, rules};
}

const CATEGORY_LABEL = {unregistered: '未登记', 'pending-rework': '已违例 · 待改造', violation: '已违例 · 新漂移'};

export function formatText(report, {scanned} = {}) {
  const lines = [];
  lines.push('共享组件签名审计（离线 · 只读）');
  if (scanned) lines.push(`扫描：${scanned.rule}`);
  lines.push('');
  report.rules.forEach((rule, index) => {
    lines.push(`[${rule.status === 'pass' ? 'PASS' : 'FAIL'}] 规则 ${index + 1}/${report.rules.length} · ${rule.id} · ${rule.title}`);
    for (const finding of rule.findings) {
      const location = finding.line > 0 ? `${finding.path}:${finding.line}` : finding.path;
      lines.push(`  类别：${CATEGORY_LABEL[finding.category] ?? finding.category}${finding.expectedFix ? ` · 修复批次 ${finding.expectedFix}` : ''}`);
      lines.push(`  - ${location}  ${finding.snippet}`);
      if (finding.note) lines.push(`    ${finding.note}`);
    }
  });
  lines.push('');
  const {summary} = report;
  lines.push(`汇总：PASS ${summary.pass} / FAIL ${summary.fail}（已违例·待改造 ${summary.pendingRework}、已违例·新漂移 ${summary.violations}、未登记 ${summary.unregistered}）`);
  lines.push(report.exitCode === 0 ? '退出码 0（全部 PASS）' : '退出码 1（有真实违规；待改造项按 spec/56 留到 B1/B2/B3/A2/B4，不算已修）');
  return lines.join('\n');
}

export function formatJson(report, extra = {}) {
  return JSON.stringify({
    ok: report.ok,
    exitCode: report.exitCode,
    summary: report.summary,
    ...extra,
    rules: report.rules,
  }, null, 2);
}

// ── 读盘（只读） ────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSTATION_ROOT = resolve(HERE, '..');
const SPEC_ROOT = resolve(WORKSTATION_ROOT, '..', 'spec');
export const REPO_PATHS = {
  scriptDir: HERE,
  workstationRoot: WORKSTATION_ROOT,
  registry: join(SPEC_ROOT, 'registry.json'),
  // 详情弹窗宽度的契约在**发布外壳**（build:v7 生成的 src/v7-shell.html）里核对；
  // prototype/v7-shell.html 是 2026-10-10 的旧原型页，不是产品外壳（B0 写稿时取错了文件）。
  shellContract: join(WORKSTATION_ROOT, 'src/v7-shell.html'),
  prototypeDir: HERE,
};

export function loadRepoFiles() {
  const entries = readdirSync(REPO_PATHS.prototypeDir).filter(name => ['mjs', 'css'].some(ext => name.endsWith('.' + ext)) && name !== basename(fileURLToPath(import.meta.url)));
  const files = entries.map(name => ({path: `prototype/${name}`, content: readFileSync(join(REPO_PATHS.prototypeDir, name), 'utf8')}));
  const shellFiles = existsSync(REPO_PATHS.shellContract)
    ? [{path: 'src/v7-shell.html', content: readFileSync(REPO_PATHS.shellContract, 'utf8')}]
    : [];
  let registry = null;
  let registryPath = 'spec/registry.json';
  try {
    registry = JSON.parse(readFileSync(REPO_PATHS.registry, 'utf8'));
  } catch (error) {
    registry = {error: error.message};
  }
  return {
    files,
    shellFiles,
    registry,
    registryPath,
    scanned: {
      rule: `prototype/*.mjs ${files.filter(file => file.path.endsWith('.mjs')).length} 个、prototype/*.css ${files.filter(file => file.path.endsWith('.css')).length} 个、shell 契约文件 ${shellFiles.length} 个；registry: ${registryPath}`,
    },
  };
}

// ── canary：内存假文件表 ───────────────────────────────────────────────────

/** 干净样本：7 条规则必须全部 0 违规。 */
export const CLEAN_TABLE = {
  files: [
    {path: 'prototype/modal.mjs', content: "export function sharedModal(document){const veil=document.querySelector('#veil');return {open(){veil.classList.add('open')},close(){veil.classList.remove('open')}}}"},
    {path: 'prototype/batch.mjs', content: "function undoBar(){const bar=document.createElement('div');bar.id='undobar';bar.innerHTML='<span data-undotext=\"1\"></span>';return bar}\nfunction showSaved(){const label=document.querySelector('[data-undotext]');label.textContent='已保存 · ';}"},
    {path: 'prototype/empty-state.mjs', content: "export function emptyState(document){const box=document.createElement('div');box.className='v7-empty';const image=document.createElement('img');image.src='/assets/illustrations/empty.svg';box.append(image);return box}"},
    {path: 'prototype/project-view.mjs', content: "export function filterBarHtml(){return '<button class=\"btn filtertoggle\">筛选</button>'}"},
    {path: 'prototype/v7-workbench.css', content: ".statusdot{width:8px;height:8px;border-radius:50%}\n.statusdot[data-state=\"draft\"]{background:var(--ws-ink)}"},
    {path: 'prototype/card.mjs', content: "export const cardDensityAttr=density=>' data-density=\"'+density+'\"';\nexport function cardOpen(){return '<button'+cardDensityAttr()+'>'}\nexport const cardClose=()=>'</button>';"},
    {path: 'prototype/project-render.mjs', content: "import {cardOpen} from './card.mjs';export function projectCard(){return cardOpen();}"},
    {path: 'prototype/task-render.mjs', content: "import {cardOpen} from './card.mjs';export function taskRow(){return cardOpen();}"},
    {path: 'prototype/task-view.mjs', content: "import {cardOpen} from './card.mjs';export function kanbanCard(){return cardOpen();}"},
    {path: 'prototype/inbox.mjs', content: "import {cardOpen} from './card.mjs';export function inboxCard(){return cardOpen({tag:'div'});}"},
  ],
  shellFiles: [
    {path: 'prototype/v7-shell.html', content: '<style>.veil.open{display:flex;align-items:center;justify-content:center}.drawer{width:760px;max-width:100%}</style>'},
  ],
  registry: {
    components: {
      items: [
        {id: 'card', variants: ['record', 'advice', 'judgment', 'canvasNode'], densities: {standard: '页面标准档', compact: '画布紧凑档'}},
      ],
    },
  },
  registryPath: 'spec/registry.json',
};

/**
 * 每条规则注入一处违规：干净 → 0，注入 → 该规则 >0。
 * 注入样本同时用作 spec/56 §10 的「违规样本」证据。
 */
export const INJECTIONS = [
  {
    ruleId: 'dialog-unique',
    name: '第二套遮罩弹窗',
    files: [{path: 'prototype/rogue-dialog.mjs', content: "const veil=document.createElement('div');veil.className='veil';document.body.append(veil);"}],
    expectCategory: 'violation',
  },
  {
    ruleId: 'dialog-width',
    name: '第二个弹窗宽度',
    files: [{path: 'prototype/rogue-width.css', content: '.modal{width:720px;max-width:100%}'}],
    expectCategory: 'violation',
  },
  {
    ruleId: 'undo-feedback',
    name: '第二处撤销反馈',
    files: [{path: 'prototype/rogue-toast.mjs', content: "const bar=document.createElement('div');bar.id='undobar';bar.querySelector('[data-undotext]').textContent='已保存 · ';"}],
    expectCategory: 'violation',
  },
  {
    ruleId: 'empty-state',
    name: '自造空态',
    files: [{path: 'prototype/rogue-empty.mjs', content: "root.innerHTML='<div class=\"v7-empty\"><img src=\"/assets/illustrations/empty.svg\"></div>';"}],
    expectCategory: 'violation',
  },
  {
    ruleId: 'status-dot',
    name: '第二个状态点定义',
    files: [{path: 'prototype/rogue-status.css', content: '.statusdot{width:8px;height:8px}'}],
    expectCategory: 'violation',
  },
  {
    ruleId: 'filter-bar',
    name: '第二处筛选条实现',
    files: [{path: 'prototype/rogue-filter.mjs', content: "export function filterBarHtml(){return '<button>筛选</button>'}"}],
    expectCategory: 'violation',
  },
  {
    ruleId: 'card-shell',
    name: '手写卡片外壳与密度',
    files: [{path: 'prototype/rogue-card.mjs', content: "const html='<button class=\"taskrow\" data-density=\"standard\">x</button>';"}],
    expectCategory: 'violation',
  },
  {
    ruleId: 'canvas-node-variant',
    name: '画布变体未登记',
    registry: {components: {items: [{id: 'card', variants: ['record', 'advice', 'judgment']}]}},
    expectCategory: 'unregistered',
  },
];

const clone = value => JSON.parse(JSON.stringify(value));

/** 在干净样本上叠加一次注入，返回新的输入。 */
export function applyInjection(injection, base = CLEAN_TABLE) {
  const files = [...clone(base.files), ...clone(injection.files ?? [])];
  const registry = injection.registry ? clone(injection.registry) : clone(base.registry);
  return {files, shellFiles: clone(base.shellFiles), registry, registryPath: base.registryPath};
}

/** --self-test：干净样本 0 违规 + 每条规则注入一处违规必红。 */
export function selfTest({log = () => {}} = {}) {
  const cleanReport = runRules(CLEAN_TABLE);
  const cases = [{
    ruleId: 'clean',
    name: '干净样本 8/8 规则 0 违规',
    ok: cleanReport.ok && cleanReport.summary.findings === 0 && cleanReport.rules.every(rule => rule.status === 'pass'),
    report: cleanReport,
  }];
  for (const injection of INJECTIONS) {
    const report = runRules(applyInjection(injection));
    const target = report.rules.find(rule => rule.id === injection.ruleId);
    const others = report.rules.filter(rule => rule.id !== injection.ruleId);
    const categoryOk = target.findings.some(finding => finding.category === injection.expectCategory);
    const ok = Boolean(target) && target.status === 'fail' && target.findings.length > 0 && categoryOk && others.every(rule => rule.status === 'pass');
    cases.push({ruleId: injection.ruleId, name: `注入「${injection.name}」→ ${injection.ruleId} 必红`, ok, report, target});
  }
  const ok = cases.every(item => item.ok);
  if (log) {
    log('共享组件签名自检（内存假文件表，不读真实仓库）');
    for (const item of cases) {
      log(`[${item.ok ? 'PASS' : 'FAIL'}] ${item.name}`);
      if (!item.ok && item.target) log(`       实际：${item.target.status} / findings=${item.target.findings.length} / ${JSON.stringify(item.target.findings.slice(0, 2))}`);
    }
    log(`自检：${cases.filter(item => item.ok).length}/${cases.length} 通过`);
  }
  return {ok, cases};
}

// ── CLI ────────────────────────────────────────────────────────────────────

const USAGE = `共享组件签名审计（离线 · 只读）

用法：
  node prototype/component-signature-audit.mjs              人读输出（默认扫 prototype/*.mjs 与 prototype/*.css）
  node prototype/component-signature-audit.mjs --json       纯 JSON 输出（可机器读）
  node prototype/component-signature-audit.mjs --self-test  内存假文件表 canary（干净 0 / 注入必红）
  node prototype/component-signature-audit.mjs --help

规则：${RULES.map(rule => rule.id).join(' / ')}
退出码：任一规则 FAIL（已违例 / 未登记）→ 1；全部 PASS → 0。`;

export function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  if (argv.includes('--self-test')) {
    const result = selfTest({log: message => console.log(message)});
    return result.ok ? 0 : 1;
  }
  const loaded = loadRepoFiles();
  const report = runRules(loaded);
  if (argv.includes('--json')) {
    console.log(formatJson(report, {scanned: loaded.scanned}));
  } else {
    console.log(formatText(report, {scanned: loaded.scanned}));
  }
  return report.exitCode;
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) {
  process.exitCode = main();
}
