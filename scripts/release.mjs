#!/usr/bin/env node
/** 发布工程：打「可复现的那一份」并给出校验和 + tag + 发布清单。
 *
 *  为什么要有「先构建」这一步（2026-10-19，03-repo 审计 §3.3）：
 *    `package.json` 的 `files: ["src"]` 是按**磁盘**打包的，而工作区里可能留着上一版生成物。
 *    旧脚本直接 `npm pack`，同一版本号会静默打出 204 个文件（发布包是 159）——
 *    "同一命令、不同结果"。现在把顺序固定成：
 *
 *    1) `npm run build:v7`（生成物重新生成，先清理过期文件）；
 *    2) 构建后 `git status --porcelain` 必须为空（生成物与源码一致，且都已提交）；
 *    3) 用 `git ls-files` 推导「应发布清单」，与 `npm pack` 的实际清单逐项比对；
 *    4) 打包到临时目录，算 SHA256，再落到 `releases/`（不覆盖已有的不同内容）；
 *    5) 打本地 tag `v<version>`（已存在则报错，不覆盖已有发布）。
 *
 *  只做确定性动作，不写业务数据。
 *  用法：
 *    node scripts/release.mjs --dry-run            # 只检查（干净树、tag 未占用、元数据完整）
 *    node scripts/release.mjs                      # 构建 → 打包 → SHA256SUMS → 打 tag
 *    node scripts/release.mjs --out <dir>          # 产物输出目录（默认 releases/）
 */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const GIT = process.env.GIT_BIN || '/usr/bin/git'; // PATH 上的 git 在本机可能是坏的 x86 二进制
const argv = process.argv.slice(2);
const flagValue = name => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const dryRun = argv.includes('--dry-run');
const outDir = resolve(ROOT, flagValue('--out') ?? 'releases');
const run = (command, args, options = {}) => execFileSync(command, args, {cwd: ROOT, encoding: 'utf8', ...options});
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = manifest.version;
const tag = 'v' + version;

const problems = [];
const notes = [];

// ── 0 · 元数据 ────────────────────────────────────────────────────────────────
if (manifest.private !== false) problems.push('package.json 仍是 private:true，不能公开发布');
if (!manifest.license) problems.push('缺少 license 字段');
if (!manifest.engines?.dsh) problems.push('缺少 engines.dsh');
for (const name of ['README.md', 'CHANGELOG.md', 'LICENSE', 'cordis.patch.yml']) {
  if (!existsSync(join(ROOT, name))) problems.push('缺少发布文件 ' + name);
}
const changelog = existsSync(join(ROOT, 'CHANGELOG.md')) ? readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8') : '';
if (!changelog.includes(version)) problems.push('CHANGELOG 未包含当前版本 ' + version);
const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');
for (const key of ['dataDirectory', 'allowedWorkspaces']) {
  if (!patch.includes(key)) problems.push('cordis.patch.yml 缺少 ' + key);
}
if (!/ABSOLUTE\/PATH|YOUR-WORKSPACE-ID/.test(patch)) notes.push('cordis.patch.yml 里没看到占位符（请确认不含个人配置）');

// ── 1 · git 状态与 tag ────────────────────────────────────────────────────────
function gitStatus() {
  try {
    return run(GIT, ['status', '--porcelain']).trim();
  } catch (error) {
    problems.push('git 检查失败：' + error.message);
    return null;
  }
}
function gitFiles() {
  const raw = run(GIT, ['ls-files', '-z'], {maxBuffer: 64 * 1024 * 1024});
  return raw.split('\u0000').filter(Boolean);
}
if (!dryRun) {
  console.log('① 构建生成物：npm run build:v7');
  try {
    run('npm', ['run', 'build:v7'], {stdio: 'inherit'});
  } catch (error) {
    problems.push('构建失败：' + error.message);
  }
}
const status = gitStatus();
if (status) {
  problems.push('工作树不干净（构建后仍有余留改动，先提交再发布）：\n' + status.split('\n').slice(0, 10).join('\n'));
}
try {
  if (run(GIT, ['tag', '--list', tag]).trim()) {
    // dry-run 是"发布前检查"：如果 tag 已经指向当前提交，说明这一版已发布过，
    // 重复 preflight 应给出说明而不是误报失败；非 dry-run 仍然拒绝覆盖已有发布。
    const head = run(GIT, ['rev-parse', 'HEAD']).trim();
    let tagged = '';
    try { tagged = run(GIT, ['rev-parse', tag + '^{commit}']).trim(); } catch {}
    if (dryRun && tagged === head) notes.push('tag ' + tag + ' 已存在且指向当前提交（这一版已发布过，dry-run 不重复发布）');
    else problems.push('tag ' + tag + ' 已存在 —— 版本递增后再发布，不覆盖已有发布');
  }
} catch (error) {
  problems.push('读取 tag 失败：' + error.message);
}

if (problems.length) {
  console.log('FAIL: 发布前检查未通过：\n  · ' + problems.join('\n  · '));
  process.exit(1);
}
console.log('发布前检查：PASS（工作树干净、tag 未占用、公开文档与元数据完整）');
for (const note of notes) console.log('  注意：' + note);

// ── 2 · 应发布清单（由 git 推导，防止未跟踪的生成物被静默打包） ────────────────
function patternToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp('^' + escaped + '$');
}
function expectedPackageFiles() {
  const includes = (manifest.files ?? []).filter(entry => !entry.startsWith('!'));
  const excludes = (manifest.files ?? []).filter(entry => entry.startsWith('!')).map(entry => patternToRegExp(entry.slice(1)));
  const hit = path => includes.some(entry => path === entry || path.startsWith(entry + '/'));
  const excluded = path => excludes.some(re => re.test(path));
  const files = gitFiles().filter(path => hit(path) && !excluded(path));
  files.push('package.json'); // npm 总会带上 package.json
  return [...new Set(files)].sort();
}

function verifyPacked(packedEntry) {
  const packedList = (packedEntry?.files ?? []).map(entry => entry.path).sort();
  const expected = expectedPackageFiles();
  const missing = expected.filter(path => !packedList.includes(path));
  const extra = packedList.filter(path => !expected.includes(path));
  if (packedList.length !== expected.length || missing.length || extra.length) {
    problems.push('包内文件数 ' + packedList.length + ' ≠ 应发布清单 ' + expected.length +
      '（多出：' + (extra.slice(0, 6).join('、') || '无') + '；缺少：' + (missing.slice(0, 6).join('、') || '无') + '）');
  }
  console.log('② 包内文件 ' + packedList.length + ' 个（应发布清单 ' + expected.length + ' 个）');
  return expected;
}

// ── 3 · 打包 / 校验 ──────────────────────────────────────────────────────────
let artifact;
if (dryRun) {
  // dry-run 只核对「当前树重新构建后会不会变」——由 npm test 里的 v7-assets 守卫覆盖；
  // 这里不写生成物，只把应发布清单打印出来，便于和 release-check 对照。
  const expected = expectedPackageFiles();
  console.log('② dry-run：应发布文件 ' + expected.length + ' 个（未打包）');
  console.log('dry-run：未打包、未打 tag。');
  process.exit(0);
}
{
  const workdir = mkdtempSync(join(tmpdir(), 'workstation-release-'));
  try {
    const raw = run('npm', ['pack', '--pack-destination', workdir, '--json', '--ignore-scripts']);
    const packed = JSON.parse(raw)[0];
    artifact = join(workdir, packed.filename);
    verifyPacked(packed);
    if (problems.length) {
      console.log('FAIL: ' + problems.join('\n  · '));
      process.exit(1);
    }
    mkdirSync(outDir, {recursive: true});
    const target = join(outDir, packed.filename);
    const digest = createHash('sha256').update(readFileSync(artifact)).digest('hex');
    if (existsSync(target)) {
      const current = createHash('sha256').update(readFileSync(target)).digest('hex');
      if (current !== digest) problems.push('同版本包已存在且内容不同：' + target + '（不覆盖；请递增版本或先归档旧包）');
    }
    if (problems.length) {
      console.log('FAIL: ' + problems.join('\n  · '));
      process.exit(1);
    }
    copyFileSync(artifact, target);
    artifact = target;
    writeFileSync(join(outDir, 'SHA256SUMS'), digest + '  ' + packed.filename + '\n', 'utf8');
    console.log('③ 已打包：' + target + '（' + packed.size + ' bytes）');
    console.log('   SHA256：' + digest);
    console.log('   校验文件：' + join(outDir, 'SHA256SUMS'));
    console.log('   包内文件数：' + (packed.files ?? []).length);
  } finally {
    rmSync(workdir, {recursive: true, force: true});
  }
}

// ── 4 · tag ─────────────────────────────────────────────────────────────────
try {
  run(GIT, ['tag', '-a', tag, '-m', 'Release ' + version]);
  console.log('④ 本地 tag：' + tag);
} catch (error) {
  console.log('FAIL: 打 tag 失败（包已生成，请检查后手动处理）：' + error.message);
  process.exit(1);
}

// ── 5 · 发布清单 ─────────────────────────────────────────────────────────────
console.log('─'.repeat(64));
console.log('发布清单（需要人工执行/确认）：');
console.log('  1. 推送仓库：' + GIT + ' push -u origin main && ' + GIT + ' push origin ' + tag);
console.log('  2. GitHub Release 只上传本次产物：' + artifact + ' 与 SHA256SUMS；不要批量上传 releases/ 里的历史 tgz');
console.log('  3. 装机验证：按 README 安装后重启 DSH；再跑 node prototype/live-acceptance.mjs 核对"看到的 = 装的"');
console.log('  4. 回滚：保留上一版 tgz + 数据库 .backup；把 profile 依赖指回旧 tgz 并重启');
