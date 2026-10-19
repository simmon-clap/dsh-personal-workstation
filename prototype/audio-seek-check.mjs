#!/usr/bin/env node
/** 判据 3 的最后一层：**点依据能跳回录音的那一段**（真实浏览器 + 真录音文件）。
 *
 *  为什么单独验：前面的层级都已验过 ——
 *    · 依据能指回对象 ✅（真实数据 8/8）
 *    · 锚点带范围、导出会写「第 120–180 秒」✅
 *    · 录音按 Range 送窗口 ✅（路由测试）
 *  但"用户点一下，播放器真的跳到那一段"是**界面行为**，只有真浏览器能证明。
 *
 *  做法：临时目录放一份真录音（`voice/inbox/voice-check.m4a`）→ 授权 → 造一条判断，
 *  依据锚点是 `录音@8-20` → 打开工作台 → 点「看原始出处」→ 断言播放器出现、说明写着"已跳到 8 秒"、
 *  并且 `currentTime` 真的落在 8 秒附近。
 *
 *  不碰真实库：用内存库 + 临时目录。
 */
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {existsSync, mkdirSync, mkdtempSync, copyFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {ExecutionStore} from '../src/execution-store.mjs';
import {HostFiles} from '../src/host-files.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const {createFsPort} = await import('./audit-fs-port.mjs');

const problems = [];
const check = (label, ok, evidence = '') => {
  console.log((ok ? '  PASS ' : '  FAIL ') + label + (evidence ? '  → ' + String(evidence).slice(0, 120) : ''));
  if (!ok) problems.push(label);
};

const source = join(here, '..', '..', 'voice', 'inbox', 'voice-check.m4a');
if (!existsSync(source)) {
  console.log('FAIL: 找不到真实录音样本 voice/inbox/voice-check.m4a —— 不是通过，是没测到');
  process.exit(1);
}

const workdir = mkdtempSync(join(tmpdir(), 'audio-seek-'));
const media = join(workdir, 'media');
mkdirSync(media, {recursive: true});
copyFileSync(source, join(media, '会议录音.m4a'));

const store = new WorkstationStore(':memory:');
const executions = new ExecutionStore(store);
const ctx = {workspace: 'w', actor: 'seek', canWrite: true};
const grant = {id: 'g', workspace: 'w', root: media, read: true, write: false, label: '音频样本'};
const fsPort = createFsPort();
const files = new HostFiles(fsPort, [grant]);
const connection = {admit: () => ({peer: {id: 'seek'}}), requestRejection: () => undefined};
const route = httpRoute({
  store, executions, files, connection,
  workspaceRegistry: {list: () => [{id: 'w', title: '个人空间', path: media}], get: () => ({id: 'w'})},
  allowedWorkspaces: ['w'],
});
const server = createServer((request, response) => route.handler(request, response));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

try {
  // 一条判断，依据指向"这份录音的第 8–20 秒"（规范 03 §10 的录音锚点形状）
  store.draft(ctx, {title: '录音跳段用', changes: [
    {op: 'create', id: 'a-rec', kind: 'artifact', data: {title: '会议录音', path: '会议录音.m4a', fileGrantId: 'g'}},
    {op: 'create', id: 'j-rec', kind: 'judgment', data: {
      title: '录音里说过的那件事', share: 'private', status: 'checking', validFrom: '2026-10-12', uncertainty: '只听到口述',
      evidence: [{kind: 'audio', ref: 'a-rec@2-4', quote: '那段话', verified: false}],
    }},
    {op: 'create', id: 'j-beyond', kind: 'judgment', data: {
      title: '锚点写到录音之外的判断', share: 'private', status: 'checking', validFrom: '2026-10-12', uncertainty: '锚点写错了',
      evidence: [{kind: 'audio', ref: 'a-rec@8-20', quote: '那段话（锚点超出录音长度）', verified: false}],
    }},
  ]});
  const batch = store.inbox(ctx, {status: 'draft'})[0];
  store.commit(ctx, {batchId: batch.id, revision: batch.revision, key: 'audio-seek'});

  const browser = await puppeteer.launch({executablePath: chromeExecutable(), headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--autoplay-policy=no-user-gesture-required']});
  const page = await browser.newPage();
  await page.setViewport({width: 1440, height: 940});
  await page.goto('http://127.0.0.1:' + server.address().port + '/personal-workstation', {waitUntil: 'networkidle0'});
  await new Promise(resolve => setTimeout(resolve, 1500));
  await page.evaluate(() => document.querySelector('.nav [data-view="knowledge"]')?.click());
  await new Promise(resolve => setTimeout(resolve, 1200));
  await page.evaluate(() => [...document.querySelectorAll('#knowtabs button')].find(button => button.textContent.includes('研究议题'))?.click());
  await new Promise(resolve => setTimeout(resolve, 1200));
  // 按 id 精确打开（列表里有两条判断，点第一条会点错）
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('#knowbody [data-id]')].find(node => node.dataset.id === 'j-rec');
    card?.click();
  });
  await new Promise(resolve => setTimeout(resolve, 1200));
  const opened = await page.evaluate(() => {
    const button = document.querySelector('#detailbody [data-evidence-ref]');
    button?.click();
    return button?.textContent ?? null;
  });
  check('依据上有「看原始出处」可点（录音类型）', Boolean(opened), String(opened));
  await new Promise(resolve => setTimeout(resolve, 2500));
  const state = await page.evaluate(() => {
    const player = document.querySelector('#audioplayer');
    const note = document.querySelector('#detailbody .notice')?.textContent ?? '';
    return {has: Boolean(player), src: player?.getAttribute('src') ?? '', currentTime: player?.currentTime ?? null, note};
  });
  check('打开的是**播放器**（不是"不支持预览"）', state.has, state.has ? '有播放器' : '没有播放器元素');
  check('说明里写清了跳到第几秒（人话，不是数字）', /已跳到 2 秒/.test(state.note), state.note.slice(0, 70));
  await new Promise(resolve => setTimeout(resolve, 2500));
  const played = await page.evaluate(() => {
    const player = document.querySelector('#audioplayer');
    player?.pause();
    return player?.currentTime ?? -1;
  });
  check('播放器**真的跳到了那一段**（currentTime ≈ 2 秒，样本总长 5.29 秒）', played >= 1.5 && played <= 4.5, 'currentTime=' + Number(played).toFixed(2) + 's');

  // 锚点比录音还长时**不许说谎**：实测样本只有 5.29 秒，写"第 8 秒"时界面必须承认停在了结尾。
  await page.evaluate(() => document.querySelector('#close')?.click());
  await new Promise(resolve => setTimeout(resolve, 700));
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('#knowbody [data-id]')].find(node => node.dataset.id === 'j-beyond');
    card?.click();
  });
  await new Promise(resolve => setTimeout(resolve, 1000));
  const openedBeyond = await page.evaluate(() => {
    const button = document.querySelector('#detailbody [data-evidence-ref]');
    button?.click();
    return Boolean(button);
  });
  check('锚点超出录音的那条依据同样点得动', openedBeyond);
  await new Promise(resolve => setTimeout(resolve, 2500));
  const honest = await page.evaluate(() => document.querySelector('#previewnote')?.textContent ?? '');
  check('锚点超出录音长度时如实说明（不谎称"已跳到"）', /只有 5 秒/.test(honest) && !/^已跳到/.test(honest.trim()), honest.slice(0, 80));
  mkdirSync(join(here, 'screenshots'), {recursive: true});
  await page.screenshot({path: join(here, 'screenshots', 'audio-seek.png')});
  await browser.close();
} catch (error) {
  problems.push('验收过程本身出错：' + (error?.message ?? error));
} finally {
  await new Promise(resolve => server.close(resolve));
  store.close();
  rmSync(workdir, {recursive: true, force: true});
}

if (problems.length) {
  console.log('FAIL: ' + problems.length + ' 项没通过 —— ' + problems.join('；'));
  process.exit(1);
}
console.log('PASS: 点依据 → 播放器打开 → 跳到锚点那一段（判据 3 的最后一层成立）。');
