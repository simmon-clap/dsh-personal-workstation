#!/usr/bin/env node
/** W4 出口：干净安装模拟（不碰现有 DSH profile 与生产数据）。
 *
 *  1) 从**发布 tarball** 解出一份插件；2) 在临时 DSH_HOME 里建只声明 base/web-app/工作台 的 profile；
 *  3) 用临时 profile 起真实 DSH web 宿主；4) 用宿主打印的 token URL 打开工作台页，确认 200 与模块哈希；
 *  5) 确认插件数据目录自动建库；6) 停宿主。
 *  限定：framework/依赖复用本机已装的一份（硬链接，不修改原 profile）；验证的是
 *  **包本身可安装可激活 + 数据目录自举 + 看到的=包里的**，不是另一台操作系统的兼容性。
 */
import {execFileSync, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync, copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';

const ROOT = join(import.meta.dirname, '..');
const APP = '/Applications/DeepSeek Harness.app/Contents/Resources';
const CLI = join(APP, 'runtime/cli/bin/dsh');
const BASE = join(tmpdir(), 'w4-clean-install');
const releases = join(ROOT, 'releases');
const tarball = readdirSync(releases).filter(name => /^dsh-personal-workstation-\d+\.\d+\.\d+\.tgz$/.test(name)).sort().at(-1);
const problems = [];
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail ? ' → ' + String(detail).slice(0, 200) : '')); if (!ok) problems.push(label); };
if (!tarball) { console.log('FAIL: releases/ 没有发布 tarball（先 npm pack）'); process.exit(1); }
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const tgz = join(releases, tarball);
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');

rmSync(BASE, {recursive: true, force: true});
const home = join(BASE, 'home');
const profile = join(home, 'profiles', 'clean');
const dataDirectory = join(BASE, 'data', 'workstation-data');
const workspaceRoot = join(BASE, 'workspace');
mkdirSync(profile, {recursive: true});
mkdirSync(dataDirectory, {recursive: true});
mkdirSync(workspaceRoot, {recursive: true});

// 依赖：硬链接复用本机已装的一份（快，不占空间；改动只发生在临时目录）。
execFileSync('cp', ['-al', join(process.env.HOME, '.dsh/profiles/desktop/node_modules'), join(profile, 'node_modules')]);
rmSync(join(profile, 'node_modules/dsh-personal-workstation'), {recursive: true, force: true});
mkdirSync(join(profile, 'node_modules/dsh-personal-workstation'), {recursive: true});
execFileSync('tar', ['-xzf', tgz, '-C', join(profile, 'node_modules/dsh-personal-workstation'), '--strip-components=1']);
const installed = join(profile, 'node_modules/dsh-personal-workstation');
check(existsSync(join(installed, 'package.json')), '发布 tarball 能解出完整插件包', tarball);
check(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version === version, '包内版本与仓库一致', version);
check(!existsSync(join(installed, '验收账本.md')), '公开包里没有内部账本');
check(!existsSync(join(installed, 'prototype')), '公开包里没有原型源码目录');

mkdirSync(join(profile), {recursive: true});
const pkg = {name: 'dsh-profile-clean-check', private: true, dependencies: {'dsh-personal-workstation': 'file:./dsh-personal-workstation-' + version + '.tgz'}, dsh: {profile: {bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-personal-workstation']}}};
writeFileSync(join(profile, 'package.json'), JSON.stringify(pkg, null, 1) + '\n', 'utf8');
copyFileSync(tgz, join(profile, 'dsh-personal-workstation-' + version + '.tgz'));
writeFileSync(join(profile, 'cordis.patch.yml'), [
  '- id: personal-workstation',
  '  name: dsh-personal-workstation',
  '  config:',
  '    dataDirectory: ' + dataDirectory,
  '    rootDirectory: ' + workspaceRoot,
  '    allowedWorkspaces: []',
  '    heartbeat:',
  '      intervalMinutes: 0',
  '',
].join('\n'), 'utf8');

const env = {...process.env, DSH_HOME: home};
const child = spawn(CLI, ['--profile', 'clean', '--no-open', '--port', '0'], {env, stdio: ['ignore', 'pipe', 'pipe']});
let output = '';
child.stdout.on('data', chunk => { output += String(chunk); });
child.stderr.on('data', chunk => { output += String(chunk); });
const waitFor = async (predicate, timeoutMs = 90000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await delay(500);
  }
  return false;
};
try {
  const ready = await waitFor(() => /dsh web: (http:\/\/[^\s]+)/.test(output));
  check(ready, '临时 profile 用发布包起得来真实 DSH 宿主', ready ? '' : output.slice(-600));
  if (ready) {
    const tokenUrl = /dsh web: (http:\/\/[^\s]+)/.exec(output)[1];
    const origin = new URL(tokenUrl).origin;
    const response = await fetch(tokenUrl, {redirect: 'manual'});
    const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
    check(cookie.includes('='), '宿主签发会话 cookie');
    const page = await fetch(origin + '/personal-workstation', {headers: {cookie}});
    check(page.ok, '干净安装后工作台页返回 200', 'HTTP ' + page.status);
    const served = await fetch(origin + '/personal-workstation/v7/space-view.mjs', {headers: {cookie}});
    check(served.ok, '干净安装后客户端资源可取', 'HTTP ' + served.status);
    if (served.ok) {
      const servedHash = createHash('sha256').update(Buffer.from(await served.arrayBuffer())).digest('hex');
      check(servedHash === sha(join(installed, 'src/v7/space-view.mjs')), '看到的 = 包里的（模块哈希一致）', servedHash.slice(0, 16));
    }
    const db = join(dataDirectory, 'workstation.sqlite');
    check(existsSync(db), '数据目录自动建库', db.replace(BASE, '<tmp>'));
    const workstationError = /personal-workstation[^\n]*(failed|did not activate)|(did not activate)[^\n]*personal-workstation/i.test(output);
    check(!workstationError, '宿主启动时工作台插件没有激活失败', (output.split('\n').find(line => /personal-workstation/.test(line)) ?? '').slice(0, 200));
  }
} finally {
  child.kill('SIGTERM');
  await delay(1500);
}
console.log('─'.repeat(60));
if (problems.length) { console.log('FAIL: 干净安装检查 ' + problems.length + ' 项未通过：' + problems.join('；')); process.exit(1); }
console.log('PASS: 发布包能在干净 DSH_HOME（空数据目录、只声明 base/web-app/工作台）里安装、激活并自举数据。');
