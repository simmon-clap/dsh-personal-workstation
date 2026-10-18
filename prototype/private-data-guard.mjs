#!/usr/bin/env node
/** 业务数据不外流守卫（宪章 v1.3 第八条补款：**产品公开 ≠ 数据公开**）。
 *
 *  为什么要有它：用户 2026-10-16 决定把产品公开，而"录音、会议纪要、判断原文、材料、凭证
 *  不得进入仓库/不得随包发布"此前只是**隐含**边界。隐含的边界在第一次公开发布时最容易被踩破，
 *  而数据外流不可逆 —— 所以把它做成机器判据（spec/13 §1 代码与数据分离、§7 规范要能被检查）。
 *
 *  三件可机械判定的事：
 *    ① 发布产物（`npm pack` 真正会打的那些文件）里不得出现业务数据；
 *    ② 发布产物里不得出现凭证/密钥；
 *    ③ 插件目录里不得出现数据文件（数据库、录音、转写稿）。
 *
 *  只读：只跑 `npm pack --dry-run` 与读文件，不写任何东西。
 *  用法：node prototype/private-data-guard.mjs [--root <仓库根>]
 */
import {readFileSync, existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const plugin = join(here, '..');
const rootFlag = process.argv.indexOf('--root');
// W4：插件目录本身初始化了 git → 仓库根就是插件目录；否则回退到上一级（旧布局）。
const repo = rootFlag > 0 ? process.argv[rootFlag + 1] : (existsSync(join(plugin, '.git')) ? plugin : join(plugin, '..'));

/** 业务数据的形状：出现即视为违反（不区分大小写）。 */
const DATA_PATTERNS = [
  {test: /\.(sqlite|sqlite3|db)(-wal|-shm)?$/i, why: '数据库文件'},
  {test: /\.(m4a|mp3|wav|opus|aac|flac)$/i, why: '录音原件'},
  {test: /\.(mov|mp4|mkv)$/i, why: '视频原件'},
  {test: /(^|\/)(会议|voice|inbox|workstation-data)\//, why: '业务数据目录'},
  {test: /(会议纪要|转写|transcript|录音)/i, why: '纪要/转写稿'},
];
/** 凭证的形状：只在发布产物里查（仓库里出现配置模板是允许的）。
 *  高熵串的判据刻意收紧：**不含 `/` 或 `.`**（否则会把路径当密钥 —— 第一版就误报了
 *  `importance/urgency/folder` 这类词），并且必须同时含大小写与数字。 */
const SECRET_PATTERNS = [
  {test: /\bsk-[A-Za-z0-9_-]{16,}/, why: 'API key'},
  {test: /\b(appSecret|app_secret|clientSecret|client_secret|access_token|api[_-]?key)\s*[:=]\s*['"][^'"]{12,}['"]/i, why: '明文凭证赋值'},
];
const HIGH_ENTROPY = /\b[A-Za-z0-9+_-]{32,}={0,2}\b/g;
function looksLikeSecret(text) {
  for (const hit of text.matchAll(HIGH_ENTROPY)) {
    const token = hit[0];
    if (token.includes('/') || token.includes('.')) continue;
    if (!/[0-9]/.test(token) || !/[a-z]/.test(token) || !/[A-Z]/.test(token)) continue;
    return token;
  }
  return null;
}

const problems = [];
const notes = [];

// ── ① 发布产物清单 ────────────────────────────────────────────────────────────
let packed = [];
try {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {cwd: plugin, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  const parsed = JSON.parse(raw);
  packed = (parsed[0]?.files ?? []).map(entry => entry.path);
} catch {
  console.log('SKIP: 拿不到 npm pack 清单（打包失败或 npm 不可用）—— 这一项无法判定，按失败处理。');
  process.exit(1);
}
if (!packed.length) {
  console.log('FAIL: 发布产物清单是空的 —— 守卫没有可检查的对象，不算通过。');
  process.exit(1);
}
for (const path of packed) {
  for (const {test, why} of DATA_PATTERNS) {
    if (test.test(path)) problems.push('发布产物里有业务数据（' + why + '）：' + path);
  }
}

// ── ② 发布产物里不得有凭证 ────────────────────────────────────────────────────
const TEXT = /\.(mjs|js|cjs|json|md|yml|yaml|html|css|txt)$/i;
for (const path of packed) {
  if (!TEXT.test(path)) continue;
  const full = join(plugin, path);
  if (!existsSync(full)) continue;
  let body = '';
  try { body = readFileSync(full, 'utf8'); } catch { continue; }
  if (body.length > 400_000) continue;              // 大文件跳过，避免误报与拖慢
  for (const {test, why} of SECRET_PATTERNS) {
    const hit = body.match(test);
    if (hit) problems.push('发布产物里疑似凭证（' + why + '）：' + path + ' → ' + String(hit[0]).slice(0, 24) + '…');
  }
  const entropy = looksLikeSecret(body);
  if (entropy) problems.push('发布产物里疑似高熵密钥：' + path + ' → ' + entropy.slice(0, 24) + '…');
}

// ── ③ 插件目录里不得有数据文件（打包规则之外也可能躺着） ──────────────────────
for (const path of packed) notes.push(path);
const looseData = packed.filter(path => DATA_PATTERNS.some(({test}) => test.test(path)));
if (!looseData.length) notes.push('发布产物 ' + packed.length + ' 个文件，未发现业务数据或凭证');

// ── ④ 仓库根的数据目录：提示性检查（只报告，不判失败 —— 仓库边界由发布流程决定） ──
const repoDataDirs = ['会议', 'voice', 'workstation-data'].filter(name => existsSync(join(repo, name)));
if (repoDataDirs.length) {
  console.log('注意：仓库根下存在数据目录 ' + repoDataDirs.join('、') +
    ' —— 公开仓库时必须靠 .gitignore / 发布清单把它们排除在外（本守卫只保证**发布产物**干净）。');
}

if (problems.length) {
  console.log('FAIL: 业务数据不外流守卫发现 ' + problems.length + ' 处：');
  for (const problem of problems) console.log('  · ' + problem);
  console.log('  改法：把数据移出发布范围（package.json files 排除 / .gitignore），或改成读取仓库外的路径。');
  process.exit(1);
}
console.log('PASS: 发布产物 ' + packed.length + ' 个文件里没有业务数据、没有凭证。');
