#!/usr/bin/env node
/** 公开仓库卫生检查（发布工程门禁，不是产品门禁）。
 *
 *  为什么重写（2026-10-19，03-repo 审计 §2.3）：旧版扫的是「磁盘上能看到的文本文件」，
 *  而且只认 3 条硬编码规则、显式跳过自己、不扫 `.sh` —— 结果仓库里 tracked 的同步脚本
 *  带着真实用户名/内网地址/作者绝对路径，它照样 PASS。这道门禁因此不能回答
 *  「**真正会进公开仓库的文件**里有没有真实值」。
 *
 *  现在的口径：
 *    ① 扫描范围 = `git ls-files`（.gitignore 已经排除的本地数据/内部文档不会误报，也不会漏掉 tracked 文件）；
 *    ② 通用形状规则不写任何真实值：真实用户家目录、内网/保留地址、Tailscale 域名、私钥与常见 token 前缀；
 *    ③ 内容级私有词表（真实客户/项目名、个人工作区 UUID）由 `PRIVATE_TERMS_FILE` 注入，词表只在仓库外保存；
 *    ④ **不豁免任何文件**，包括本检查器自己 —— 它必须自己先干净。
 *
 *  用法：
 *    node prototype/public-repo-check.mjs
 *    PRIVATE_TERMS_FILE=/path/to/private-terms.txt node prototype/public-repo-check.mjs
 *    node prototype/public-repo-check.mjs --self-test    # 注入已知违规，证明规则真的会红
 */
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {extname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const GIT = process.env.GIT_BIN || '/usr/bin/git';
const TEXT_EXT = new Set([
  '.mjs', '.js', '.cjs', '.ts', '.json', '.yml', '.yaml', '.md', '.html', '.css',
  '.txt', '.svg', '.sh', '.bash', '.zsh', '.py', '.toml', '.ini', '.cfg', '.xml',
]);
/** 通用形状规则：这里只能出现「形状」，不能出现任何真实值。 */
const RULES = [
  {
    // 真实用户家目录：/Users/<name>/ 或 /home/<name>/；示例占位名放行。
    test: line => {
      const hits = [];
      for (const match of line.matchAll(/\/(?:Users|home)\/([A-Za-z0-9._-]+)\//g)) {
        const name = match[1].toLowerCase();
        if (['example', 'user', 'username', 'yourname', 'shared', 'runner', 'public'].includes(name)) continue;
        hits.push(match[0]);
      }
      return hits;
    },
    why: '真实用户家目录绝对路径（非 example/user 占位）',
  },
  {test: line => line.match(/(?<![\d.])(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2})(?![\d.])/g), why: '内网/保留 IPv4 地址（10/8、172.16/12、192.168/16、100.64/10）'},
  {test: line => line.match(/\b[a-z0-9-]+\.ts\.net\b/ig), why: 'Tailscale 私有域名'},
  {test: line => line.match(/\bsk-[A-Za-z0-9_-]{16,}/g), why: '疑似 API key（sk- 前缀）'},
  {test: line => line.match(/\bghp_[A-Za-z0-9]{20,}/g), why: '疑似 GitHub token（ghp_ 前缀）'},
  {test: line => line.match(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g), why: '疑似 Slack token（xox* 前缀）'},
  {test: line => line.match(/\bAKIA[0-9A-Z]{16}\b/g), why: '疑似 AWS access key'},
  {test: line => line.match(/BEGIN [A-Z ]*PRIVATE KEY/g), why: '私钥内容'},
];

/** 逐行跑规则；返回 {file,line,why} 列表。只看前 2MB、跳过含 NUL 的二进制。 */
export function scanText(path, body, privateTerms = []) {
  const problems = [];
  const lines = body.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const rule of RULES) {
      const hits = rule.test(line);
      if (hits && hits.length) problems.push({file: path, line: index + 1, why: rule.why});
    }
    for (const term of privateTerms) {
      if (line.includes(term)) problems.push({file: path, line: index + 1, why: '内容级私有词命中（词表在仓库外，不打印具体词）'});
    }
  }
  return problems;
}

function isTextFile(path) {
  const ext = extname(path).toLowerCase();
  if (TEXT_EXT.has(ext)) return true;
  return ext === ''; // LICENSE / Makefile / 无扩展名脚本
}

function trackedFiles() {
  try {
    const raw = execFileSync(GIT, ['-C', root, 'ls-files', '-z'], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
    return raw.split('\u0000').filter(Boolean);
  } catch (error) {
    console.error('FAIL: 拿不到 git ls-files 清单（不是 git 仓库或 git 不可用）：' + (error?.message ?? error));
    console.error('  这道门禁必须基于「真正会进仓库的文件」判定；拿不到清单时不能算通过。');
    process.exit(1);
  }
}

function readPrivateTerms() {
  const file = process.env.PRIVATE_TERMS_FILE;
  if (!file) return [];
  if (!existsSync(file)) {
    console.error('FAIL: PRIVATE_TERMS_FILE 指向的文件不存在：' + file);
    process.exit(1);
  }
  return readFileSync(file, 'utf8').split('\n').map(item => item.trim()).filter(item => item && !item.startsWith('#'));
}

function main() {
  const privateTerms = readPrivateTerms();
  const files = trackedFiles();
  const problems = [];
  let scanned = 0;
  for (const path of files) {
    if (!isTextFile(path)) continue;
    const full = join(root, path);
    if (!existsSync(full)) continue;
    const buffer = readFileSync(full);
    if (buffer.length > 2_000_000 || buffer.includes(0)) continue;
    scanned += 1;
    problems.push(...scanText(path, buffer.toString('utf8'), privateTerms));
  }
  if (!scanned) {
    console.error('FAIL: 没有可扫描的文本文件 —— 门禁没有可检查的对象，不算通过。');
    process.exit(1);
  }
  if (problems.length) {
    console.log('FAIL: 公开仓库卫生检查发现 ' + problems.length + ' 处：');
    for (const item of problems) console.log('  · ' + item.file + ':' + item.line + '：' + item.why);
    console.log('  改法：删除真实值；需要长期保留的私有词（客户/项目名、工作区 ID）放进仓库外的 PRIVATE_TERMS_FILE，检查时注入。');
    process.exit(1);
  }
  console.log('PASS: 公开仓库卫生检查通过（git ls-files ' + files.length + ' 个文件，扫描文本 ' + scanned +
    ' 个；无真实家目录 / 内网地址 / Tailscale 域名 / 凭证形状' +
    (privateTerms.length ? '；已注入 ' + privateTerms.length + ' 个私有词且 0 命中' : '；未提供私有词表') + '）。');
}

/** 自检：注入已知违规，规则必须真的红；干净样本必须放行。用拼接构造，避免检查器自己命中自己。 */
function selfTest() {
  const slash = '/';
  const home = slash + 'Users' + slash;
  const privateTerm = '内部' + '项目代号X';
  const fixtures = [
    {path: 'clean.mjs', body: "const p = '" + home + "example/Desktop'; const ip = '127.0.0.1';", expect: 0},
    {path: 'leak.sh', body: 'cd ' + home + 'realperson' + slash + 'Desktop', expect: 1},
  ];
  // IP / token / 私有词用运行时拼接，源码里不出现可命中的字面值。
  const ipLine = 'REMOTE=100.' + '103.17.44';
  fixtures.push({path: 'lan.mjs', body: ipLine, expect: 1});
  fixtures.push({path: 'secret.txt', body: 'token = "' + 'sk-' + 'abcdefghijklmnopqrstuvwx' + '"', expect: 1});
  fixtures.push({path: 'private.mjs', body: '主题=' + privateTerm, expect: 1});
  const failures = [];
  for (const fixture of fixtures) {
    const hits = scanText(fixture.path, fixture.body, [privateTerm]);
    if (hits.length !== fixture.expect) failures.push(fixture.path + ' 期望 ' + fixture.expect + ' 处，实际 ' + hits.length + ' 处');
  }
  // 扩展名口径：.sh 必须在扫描范围里（旧版漏掉的正是这一类）。
  for (const name of ['leak.sh', 'leak.py', 'leak']) if (!isTextFile(name)) failures.push(name + ' 应在扫描范围');
  if (failures.length) {
    console.log('FAIL: 公开仓库检查器自检未通过：');
    for (const failure of failures) console.log('  · ' + failure);
    process.exit(1);
  }
  console.log('PASS: 自检通过（家目录/.sh/内网 IP/凭证/私有词 都能判红，干净样本放行）。');
}

if (process.argv.includes('--self-test')) selfTest();
else main();
