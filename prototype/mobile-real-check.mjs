#!/usr/bin/env node
/** 判据 2：**出差时手机上能独立完成一次「看 → 判断 → 决定」**（真实数据 + 真 390px 浏览器）。
 *
 *  为什么单独一个脚本：`mobile-audit` 只在**夹具**上量"有没有溢出/点击区够不够"，
 *  它证明不了"用真实数据、在手机上真的能做完一次决定，而且决定真的落库"。
 *  判据 2 的原话就是"独立完成一次看→判断→决定"，所以必须走完整链路。
 *
 *  做法：`sqlite3 .backup` 取真实库副本（WAL 安全）→ 对副本起 HTTP → 390×844 真浏览器：
 *    ① 看：知识页 → 研究议题 → 打开一条判断
 *    ② 判断：详情里能看到依据条数与不确定性
 *    ③ 决定：编辑判断 → 状态改为"已被推翻" + 写理由 → 保存
 *    ④ 验证：副本库里真的变成 overturned，且 `overturnedBy.reason` 有理由、**依据的出处还在**
 *  全程量三件事：横向溢出 = 0 · 用到的控件点击区 ≥44 · 保存后没有 JS 报错。
 *
 *  只读副本，**真库一个字不动**。用法：node prototype/mobile-real-check.mjs [库路径]
 */
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {existsSync, mkdtempSync, rmSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {ExecutionStore} from '../src/execution-store.mjs';
import {seedVisualStore} from './visual-seed.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = process.argv[2] ?? join(here, '..', '..', 'workstation-data', 'workstation.sqlite');
if (!existsSync(source)) {
  console.log('FAIL: 找不到真实库：' + source + '（不是通过，是没测到）');
  process.exit(1);
}

const problems = [];
const check = (label, ok, evidence = '') => {
  console.log((ok ? '  PASS ' : '  FAIL ') + label + (evidence ? '  → ' + String(evidence).slice(0, 130) : ''));
  if (!ok) problems.push(label);
};

const workdir = mkdtempSync(join(tmpdir(), 'mobile-real-'));
const copy = join(workdir, 'copy.sqlite');
const shots = join(here, 'screenshots', 'mobile-real');
mkdirSync(shots, {recursive: true});
execFileSync('/usr/bin/sqlite3', [source, '.backup ' + copy]);   // WAL 安全的只读副本

const store = new WorkstationStore(copy);
const executions = new ExecutionStore(store);
seedVisualStore(store);
const ctx = {workspace: store.batchScopes()[0], actor: 'mobile-real', canWrite: true};
const connection = {admit: () => ({peer: {id: 'mobile-real'}}), requestRejection: () => undefined};
const route = httpRoute({store, executions, connection, workspaceRegistry: {list: () => [{id: ctx.workspace, title: '个人空间'}], get: () => ({id: ctx.workspace})}, allowedWorkspaces: [ctx.workspace]});
const server = createServer((request, response) => route.handler(request, response));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const browser = await puppeteer.launch({executablePath: chromeExecutable(), headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']});
const page = await browser.newPage();
await page.setViewport({width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1});
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
const settle = ms => new Promise(resolve => setTimeout(resolve, ms));
const overflow = () => page.evaluate(() => {
  const doc = document.documentElement;
  return Math.max(0, doc.scrollWidth - doc.clientWidth);
});

try {
  const target = store.list(ctx, {kind: 'judgment', limit: 50}).find(item => (item.data.evidence ?? []).length > 0);
  if (!target) {
    console.log('FAIL: 真实库里没有带依据的判断，这条判据这次无从验起（不是通过）');
    process.exit(1);
  }
  const beforeRefs = (target.data.evidence ?? []).map(one => ({kind: one.kind, ref: one.ref}));

  await page.goto('http://127.0.0.1:' + server.address().port + '/personal-workstation', {waitUntil: 'networkidle0'});
  await settle(1500);

  // ① 看
  await page.evaluate(() => document.querySelector('.nav [data-view="knowledge"]')?.click());
  await settle(1400);
  await page.evaluate(() => [...document.querySelectorAll('#knowtabs button')].find(button => button.textContent.includes('研究议题'))?.click());
  await settle(1200);
  check('手机上找得到判断列表（知识 · 研究议题）', await page.evaluate(() => document.querySelectorAll('#knowbody [data-id]').length > 0), await page.evaluate(() => document.querySelectorAll('#knowbody [data-id]').length + ' 张'));
  check('列表页没有横向溢出', (await overflow()) === 0, '溢出 ' + (await overflow()) + 'px');
  await page.screenshot({path: join(shots, '1-列表.png')});

  // ② 判断（打开那条真实判断）
  await page.evaluate(id => {
    const card = [...document.querySelectorAll('#knowbody [data-id]')].find(node => node.dataset.id === id);
    (card ?? document.querySelector('#knowbody [data-id]'))?.click();
  }, target.id);
  await settle(1400);
  const detail = await page.evaluate(() => document.querySelector('#veil')?.innerText ?? '');
  check('详情里看得到依据与不确定性（"判断"这一步的材料齐）', /依据/.test(detail) && /不确定性/.test(detail), detail.replace(/\s+/g, ' ').slice(0, 80));
  check('详情没有横向溢出', (await overflow()) === 0, '溢出 ' + (await overflow()) + 'px');
  const small = await page.evaluate(() => [...document.querySelectorAll('#veil button')]
    .filter(button => button.offsetParent !== null)
    .map(button => ({text: ((button.textContent || '').trim() || button.id || button.className || button.getAttribute('aria-label') || '(无文字)').slice(0, 22), box: button.getBoundingClientRect()}))
    .filter(row => row.box.width > 0 && (row.box.height < 44 || row.box.width < 44))
    .map(row => row.text + '(' + Math.round(row.box.width) + '×' + Math.round(row.box.height) + ')'));
  check('详情里的控件点击区 ≥44（手机上点得准）', small.length === 0, small.slice(0, 3).join('、'));
  await page.screenshot({path: join(shots, '2-详情.png')});

  // ③ 决定：编辑判断 → 状态改成"已被推翻" + 写理由 → 保存
  const openedEditor = await page.evaluate(() => {
    const button = [...document.querySelectorAll('#detailbody button')].find(node => node.textContent === '编辑判断');
    button?.click();
    return Boolean(button);
  });
  await settle(1400);
  check('手机上打得开「编辑判断」', openedEditor && await page.evaluate(() => Boolean(document.querySelector('[data-field="status"]'))));
  const reason = '手机上判断：对方的排期只有口述，没有任何书面材料';
  const filled = await page.evaluate(value => {
    const status = document.querySelector('[data-field="status"]');
    const reasonField = document.querySelector('[data-field="overturnReason"]');
    if (!status || !reasonField) return false;
    status.value = 'overturned';
    reasonField.value = value;
    return true;
  }, reason);
  await page.evaluate(() => document.querySelector('#objpreview')?.click());
  await settle(1800);
  check('保存后没有 JS 报错', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

  // ④ 验证决定真的落库（副本）
  const after = store.get(ctx, target.id);
  check('决定真的写进了库（状态 = 已被推翻）', after?.data?.status === 'overturned', 'status=' + after?.data?.status);
  check('推翻留痕里有你写的理由', (after?.data?.overturnedBy?.reason ?? '') === reason, String(after?.data?.overturnedBy?.reason ?? '（没有理由）').slice(0, 50));
  const refsAfter = (after?.data?.evidence ?? []).map(one => one.kind + '|' + one.ref);
  const kept = beforeRefs.filter(one => refsAfter.includes(one.kind + '|' + one.ref)).length;
  check('改状态没有把依据的出处弄丢（判据 3 不被编辑破坏）', kept === beforeRefs.length, '改前 ' + beforeRefs.length + ' 条 · 改后仍在 ' + kept + ' 条');
  await page.screenshot({path: join(shots, '3-决定后.png')});

  console.log('\n截图：' + shots + '（390×844 真实数据）');
} catch (error) {
  problems.push('验收过程本身出错：' + (error?.message ?? error));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  store.close();
  rmSync(workdir, {recursive: true, force: true});
}

if (problems.length) {
  console.log('FAIL: ' + problems.length + ' 项没通过 —— ' + problems.join('；'));
  process.exit(1);
}
console.log('PASS: 真实数据 + 真 390px 浏览器上，「看 → 判断 → 决定」一次走通，决定落库、留痕与出处都在。');
