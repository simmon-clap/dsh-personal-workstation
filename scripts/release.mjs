#!/usr/bin/env node
/** W4 发布工程：打「可发布的那一份」并给出校验和 + 发布清单。
 *
 *  只做确定性动作，不改业务数据：
 *    1) 要求 git 工作树干净（否则发布的是"没提交的那份"）；
 *    2) `npm pack` 出 tarball，写 SHA256SUMS；
 *    3) 打本地 git tag（v<version>，已存在则报错，不覆盖已有发布）；
 *    4) 打印发布清单（远程推送命令、回滚包、验证命令）。
 *  用法：node scripts/release.mjs [--dry-run]
 */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const GIT = '/usr/bin/git'; // PATH 上的 git 可能是坏的（实测 /usr/local/bin/git Bad CPU type）
const dryRun = process.argv.includes('--dry-run');
const run = (command, args, options = {}) => execFileSync(command, args, {cwd: ROOT, encoding: 'utf8', ...options});
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = manifest.version;
const tag = 'v' + version;

const problems = [];
if (manifest.private !== false) problems.push('package.json 仍是 private:true，不能公开发布');
if (!manifest.license) problems.push('缺少 license 字段');
if (!manifest.engines?.dsh) problems.push('缺少 engines.dsh');
for (const name of ['README.md', 'CHANGELOG.md', 'LICENSE']) if (!existsSync(join(ROOT, name))) problems.push('缺少公开文档 ' + name);
try {
  const status = run(GIT, ['status', '--porcelain']).trim();
  if (status) problems.push('工作树不干净（先提交再发布）：\n' + status.split('\n').slice(0, 8).join('\n'));
  const tags = run(GIT, ['tag', '--list', tag]).trim();
  if (tags) problems.push('tag ' + tag + ' 已存在 —— 版本递增后再发布，不覆盖已有发布');
} catch (error) {
  problems.push('git 检查失败：' + error.message);
}
if (problems.length) {
  console.log('FAIL: 发布前检查未通过：\n  · ' + problems.join('\n  · '));
  process.exit(1);
}
console.log('发布前检查：PASS（工作树干净、tag 未占用、公开文档齐全、元数据完整）');
if (dryRun) {
  console.log('dry-run：未打包、未打 tag。');
  process.exit(0);
}
mkdirSync(join(ROOT, 'releases'), {recursive: true});
const packOutput = run('npm', ['pack', '--pack-destination', 'releases', '--json']);
const packed = JSON.parse(packOutput)[0];
const tarball = join(ROOT, 'releases', packed.filename);
const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex');
writeFileSync(join(ROOT, 'releases', 'SHA256SUMS'), digest + '  ' + packed.filename + '\n', 'utf8');
run(GIT, ['tag', '-a', tag, '-m', 'Release ' + version]);
console.log('已打包：releases/' + packed.filename + '（' + packed.size + ' bytes）');
console.log('SHA256：' + digest);
console.log('本地 tag：' + tag);
console.log('─'.repeat(60));
console.log('发布清单（需要你做/确认的）：');
console.log('  1. 设置远程仓库后：' + GIT + ' remote add origin <你的 GitHub 地址>');
console.log('  2. 推送：' + GIT + ' push -u origin main && ' + GIT + ' push origin ' + tag);
console.log('  3. 装机验证（干净机器）：按 README 的 4 步；或本机 `npm run verify:clean-install`');
console.log('  4. 回滚包：releases/ 里上一个版本 tgz（旧版保留）');
console.log('  5. 装到本机：npm run install:local 后重启 DSH，再跑 live-acceptance');
