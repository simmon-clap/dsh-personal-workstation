#!/usr/bin/env node
/** 定位门禁（53 §3.7 / registry.positioning）——**产品代码与默认文案不得出现天宽专用词**。
 *
 *  起因（用户 2026-10-21）：「这不是个只服务天宽的画布」。四极是天宽生态的一个**示例模板**，
 *  不是产品默认分类；产品里换成任何用户的分类都能工作。所以这条不能靠自觉，得做成闸门：
 *  产品表面（随包发布的代码与默认文案）出现专用词即失败；专用词只允许留在 spec 文档、
 *  演示数据、测试夹具与验收证据里。
 *
 *  判据来源：spec/registry.json 的 `positioning` 段（词表/白名单都在那张表里，本脚本不写死词表；
 *  改词表走登记表，避免"两处口径"）。
 *
 *  用法：
 *    node prototype/positioning-check.mjs              # 检查；有真实违规退出码 1
 *    node prototype/positioning-check.mjs --json       # 机器可读
 *    node prototype/positioning-check.mjs --self-test  # canary：干净 0 违规 + 每种违规注入必红
 *
 *  边界（不掩盖）：本脚本只扫**仓库内的产品表面**；`spec/` 在仓库外（工作区根），
 *  演示目录与 spec 文档不在扫描范围内——它们本来就是白名单。
 *  本文件自身不参与扫描（它是工具，词表来自登记表而不是字面量）。
 */
import {readFileSync, readdirSync, existsSync, statSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');                 // workstation/
const repo = join(root, '..');                 // 工作区根
const REGISTRY = join(repo, 'spec', 'registry.json');

/** 产品表面：随包发布/生成进发布物的目录。 */
export const SCAN_ROOTS = ['src', 'client', 'skills', 'design-system', 'prototype'];
/** 只扫文本源码；截图/二进制跳过。 */
export const TEXT_FILE = /\.(mjs|js|css|html|json)$/;
/** 白名单：测试夹具、证据、验收工具、发布包、架构文档——这些地方允许出现真实组织名。 */
export const WHITELIST = [
  /^test\//,
  /^releases\//,
  /^prototype\/screenshots\//,
  /^prototype\/accept-[^/]+\.mjs$/,
  /^prototype\/replica\//,
  /^prototype\/frozen\//,
  /^prototype\/positioning-check\.mjs$/,
  /^src\/v7\/.*\.json$/,
];
/** 演示目录不得被产品代码引用（否则产品默认路径会依赖演示数据）。用拼接构造，避免本文件自命中。 */
export const DEMO_MARKER = ['canvas', 'ecosystem', 'demo'].join('-');

export function readRegistry(path = REGISTRY) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** 从 registry 取出本门禁的口径；缺字段就如实报错，不静默放行。 */
export function ruleBook(registry) {
  const positioning = registry?.positioning;
  if (!positioning) throw Error('registry 缺少 positioning 段：定位门禁没有口径，不能算通过');
  const bannedTerms = Array.isArray(positioning.bannedTerms) ? positioning.bannedTerms.filter(term => typeof term === 'string' && term.trim()) : [];
  if (!bannedTerms.length) throw Error('registry.positioning.bannedTerms 为空：词表缺失，门禁不能算通过');
  return {bannedTerms, productName: String(positioning.productName ?? '')};
}

/** 收集真实仓库里要扫的文件（路径相对 workstation/）。 */
export function collectFiles(roots = SCAN_ROOTS) {
  const files = [];
  const walk = current => {
    for (const entry of readdirSync(current, {withFileTypes: true})) {
      const full = join(current, entry.name);
      const rel = relative(root, full).split('\\').join('/');
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '_archive') continue;
        if (WHITELIST.some(rule => rule.test(rel + '/'))) continue;
        walk(full);
        continue;
      }
      if (!TEXT_FILE.test(entry.name)) continue;
      if (WHITELIST.some(rule => rule.test(rel))) continue;
      let content;
      try { content = readFileSync(full, 'utf8'); } catch { continue; }
      files.push({path: rel, content});
    }
  };
  for (const name of roots) {
    const full = join(root, name);
    if (!existsSync(full) || !statSync(full).isDirectory()) continue;
    walk(full);
  }
  return files;
}

/** 规则 1：词表里的专用词在产品表面出现 = 违规（含注释与默认文案）。 */
export function checkBannedTerms(files, bannedTerms) {
  const violations = [];
  for (const file of files) {
    const lines = file.content.split('\n');
    for (const term of bannedTerms) {
      lines.forEach((line, index) => {
        if (line.includes(term)) violations.push({rule: 'bannedTerms', file: file.path, line: index + 1, term});
      });
    }
  }
  return {id: 'bannedTerms', label: '产品表面无天宽专用词', count: violations.length, violations};
}

/** 规则 2：产品代码不得引用演示目录（演示只作参照，不能成为产品默认路径）。 */
export function checkDemoLeak(files, marker = DEMO_MARKER) {
  const violations = [];
  for (const file of files) {
    const lines = file.content.split('\n');
    lines.forEach((line, index) => {
      if (line.includes(marker)) violations.push({rule: 'demoLeak', file: file.path, line: index + 1, term: marker});
    });
  }
  return {id: 'demoLeak', label: '产品代码不引用演示目录', count: violations.length, violations};
}

/** 规则 3：画布的产品名是「关联空间」——外壳里必须真的这么叫（正断言，不是只有反向黑名单）。 */
export function checkProductName(files, productName) {
  const shell = files.find(file => file.path.endsWith('src/v7-shell.html'));
  const label = String(productName).split('（')[0].trim();
  if (!shell) return {id: 'productName', label: '画布产品名正确', count: 0, skipped: '未找到 src/v7-shell.html（build:v7 未跑？）', violations: []};
  if (!shell.content.includes(label)) {
    return {id: 'productName', label: '画布产品名正确', count: 1, violations: [{rule: 'productName', file: shell.path, line: 0, term: label}]};
  }
  return {id: 'productName', label: '画布产品名正确', count: 0, violations: []};
}

/** 全部规则。纯函数：文件表由调用方给，便于 canary 用假文件表证明「干净不误报、注入必红」。 */
export function scan({files, bannedTerms, productName}) {
  const rules = [checkBannedTerms(files, bannedTerms), checkDemoLeak(files), checkProductName(files, productName)];
  const total = rules.reduce((sum, rule) => sum + rule.count, 0);
  return {rules, total};
}

function printReport(report) {
  for (const rule of report.rules) {
    const state = rule.skipped ? 'skip  ' : rule.count ? 'FAIL  ' : 'ok    ';
    const tail = rule.skipped ? '（' + rule.skipped + '）' : rule.count + ' 处';
    console.log(state + rule.label.padEnd(24, ' ') + tail);
  }
  for (const rule of report.rules) {
    for (const item of rule.violations.slice(0, 8)) console.log('      ' + item.file + (item.line ? ':' + item.line : '') + ' → ' + item.term);
  }
  console.log(report.total ? `FAIL: 定位门禁发现 ${report.total} 处违规（产品不该出现这些词；它们只允许留在 spec/演示/测试夹具里）。` : 'PASS: 产品表面没有天宽专用词，画布产品名正确。');
}

const isCli = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return fileURLToPath(import.meta.url) === entry; } catch { return false; }
})();

const args = process.argv.slice(2);
const jsonOnly = args.includes('--json');
const selfTest = args.includes('--self-test');

if (isCli && selfTest) {
  // canary：干净样本必须 0 违规；每条规则注入一处必须抓到。哪条抓不到就说明门禁失效。
  const book = ruleBook(readRegistry());
  const clean = [
    {path: 'src/app.mjs', content: "export const label='关联空间';"},
    {path: 'src/v7-shell.html', content: '<button data-view="space">关联空间</button>'},
  ];
  const probes = [
    ['bannedTerms', [...clean, {path: 'src/bad.mjs', content: "export const org='" + book.bannedTerms[0] + "';"}], 'bannedTerms'],
    ['demoLeak', [...clean, {path: 'prototype/bad.mjs', content: "import x from '../spec/" + DEMO_MARKER + "/a.mjs';"}], 'demoLeak'],
    ['productName', [{path: 'src/app.mjs', content: 'export const x=1;'}, {path: 'src/v7-shell.html', content: '<button>画布</button>'}], 'productName'],
  ];
  const base = scan({files: clean, bannedTerms: book.bannedTerms, productName: book.productName});
  const failures = [];
  if (base.total !== 0) failures.push('干净样本应 0 违规，实测 ' + base.total);
  for (const [name, files, ruleId] of probes) {
    const report = scan({files, bannedTerms: book.bannedTerms, productName: book.productName});
    const hit = report.rules.find(rule => rule.id === ruleId);
    if (!hit || hit.count < 1) failures.push('注入违规没被抓到：' + name);
  }
  if (failures.length) {
    console.log('FAIL: 定位门禁自检未通过——' + failures.join('；'));
    process.exit(1);
  }
  console.log('PASS: 定位门禁自检通过（干净样本 0 违规；3/3 规则注入必红）。');
  process.exit(0);
}

if (isCli) {
  const book = ruleBook(readRegistry());
  const report = scan({files: collectFiles(), bannedTerms: book.bannedTerms, productName: book.productName});
  if (jsonOnly) console.log(JSON.stringify(report, null, 1));
  else printReport(report);
  process.exit(report.total ? 1 : 0);
}
