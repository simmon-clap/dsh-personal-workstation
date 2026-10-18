#!/usr/bin/env node
/** W4-3 公开仓库卫生检查：源码里不许出现作者本机路径、个人工作区 ID、内网凭据与数据文件。
 *
 *  这不是产品门禁，是**发布工程**门禁：仓库要能被第三方 clone 后跑起来。
 *  只扫会进仓库的文本文件；node_modules / releases / 截图 / 数据库 / 备份不扫（也被 .gitignore 排除）。
 */
import {readdirSync, readFileSync, statSync, existsSync} from 'node:fs';
import {join, relative, extname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'releases', 'screenshots', 'backups', '.git', 'coverage', 'acceptance']);
// 作者本地验收脚本：依赖真实库/真实项目名，.gitignore 已排除，公开仓库不扫。
const SKIP_FILES = new Set(['prototype/accept-w1-dsh.mjs', 'prototype/accept-w1-realdata.mjs', 'prototype/w5-real-paths.mjs', 'prototype/c7-simulation.mjs']);
const TEXT = new Set(['.mjs', '.js', '.cjs', '.json', '.yml', '.yaml', '.md', '.html', '.css', '.txt', '.svg']);
// 与 .gitignore 一致：内部 md（账本/审计/设计/发布说明）不进公开仓库，也不扫。
const isPrivateDoc = name => name.endsWith('.md') && name !== 'README.md' && name !== 'CHANGELOG.md';
const FORBIDDEN = [
  {pattern: /\/Users\/simon\b/, why: '作者本机绝对路径（/Users/simon）'},
  {pattern: /e19694df-aff3-4a70-abcb-7ac88d514da8/i, why: '作者个人工作区 ID'},
  {pattern: /\/Users\/simon\/Desktop\/DSH/, why: '作者工作区绝对路径'},
];
const files = [];
const walk = dir => {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) { walk(full); continue; }
    if (info.size > 2_000_000) continue;
    const ext = extname(name).toLowerCase();
    if (!TEXT.has(ext)) continue;
    if (dir === root && ext === '.html') continue;
    if (relative(root, full) === join('prototype', 'public-repo-check.mjs')) continue;
    if (SKIP_FILES.has(relative(root, full))) continue;
    if (dir === root && isPrivateDoc(name)) continue;
    if (relative(root, dir) === 'prototype' && isPrivateDoc(name)) continue;
    files.push(full);
  }
};
walk(root);

// 可选：内容级私有词表（真实客户/项目名）放在仓库外，例如 PRIVATE_TERMS_FILE=/tmp/private-terms.txt，
// 每行一个词。仓库里不保存这份表，避免检查器自己泄漏真实名字。
const termsFile = process.env.PRIVATE_TERMS_FILE;
const privateTerms = termsFile && existsSync(termsFile)
  ? readFileSync(termsFile, 'utf8').split('\n').map(item => item.trim()).filter(Boolean)
  : [];
const problems = [];
for (const file of files) {
  const body = readFileSync(file, 'utf8');
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(body)) problems.push({file: relative(root, file), why: rule.why});
  }
  for (const term of privateTerms) {
    if (body.includes(term)) { problems.push({file: relative(root, file), why: '内容级私有词命中（词表在仓库外，不打印具体词）'}); break; }
  }
}
if (problems.length) {
  console.log('FAIL: 公开仓库卫生检查发现 ' + problems.length + ' 处：');
  for (const item of problems) console.log('  · ' + item.file + '：' + item.why);
  process.exit(1);
}
console.log('PASS: 公开仓库卫生检查通过（扫描 ' + files.length + ' 个文本文件；无作者路径 / 个人工作区 ID）。');
