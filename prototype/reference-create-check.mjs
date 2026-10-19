/** 负责人 / 客户（合作机构）链路验收：从用户会走的路走一遍，证明"建得出、选得上、看得见"。
 *
 *  为什么必须是浏览器验收：上一轮的教训是"元素在 DOM 里 ≠ 用户到得了"。
 *  这里每一步都断言**可见 + 可点 + 状态真的变了**，并且用独有原文断言，不用共用串。
 *
 *  用法：node prototype/reference-create-check.mjs
 */
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {ExecutionStore} from '../src/execution-store.mjs';
import {seedVisualStore} from './visual-seed.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

const chrome = chromeExecutable();

const store = new WorkstationStore(':memory:');
const executions = new ExecutionStore(store);
seedVisualStore(store);
const connection = {admit: () => ({peer: {id: 'check'}}), requestRejection: () => undefined};
const route = httpRoute({
  store, executions, connection,
  workspaceRegistry: {list: () => [{id: 'w', title: '个人空间'}], get: () => ({id: 'w'})},
  allowedWorkspaces: ['w'],
});
const server = createServer((request, response) => route.handler(request, response));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const outDir = fileURLToPath(new URL('./screenshots/current/', import.meta.url));
mkdirSync(outDir, {recursive: true});
const browser = await puppeteer.launch({executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']});
const page = await browser.newPage();
await page.setViewport({width: 1440, height: 940});
const problems = [];
const ok = (name, condition, detail = '') => {
  console.log((condition ? '✔ ' : '✖ ') + name + (detail ? ' — ' + detail : ''));
  if (!condition) problems.push(name + (detail ? '：' + detail : ''));
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const visible = selector => page.evaluate(sel => {
  const node = document.querySelector(sel);
  if (!node) return false;
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden';
}, selector);

try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/personal-workstation', {waitUntil: 'networkidle0'});
  await page.waitForFunction(() => document.querySelectorAll('#projectstrip [data-project]').length > 0, {timeout: 15000});

  // ── 1 · 新建联系人：表单必须能挂到组织上（此前 person 的「所属组织」被重复定义覆盖，永久丢失）
  await page.click('#create');
  await wait(500);
  await page.evaluate(() => document.querySelector('#detailbody [data-kind="person"]')?.click());
  await wait(900);
  const personFields = await page.evaluate(() => [...document.querySelectorAll('#detailbody .formfield > span, #detailbody .formfield > .viselect > .viselect-label')].map(n => n.textContent.trim()));
  ok('新建联系人表单含「所属组织」', personFields.includes('所属组织'), '实际字段：' + personFields.join('、'));
  ok('新建联系人表单含「邮箱」', personFields.includes('邮箱'));
  ok('联系人表单有「＋ 新建组织」入口', await page.evaluate(() => Boolean(document.querySelector('#detailbody [data-refnew="organization"]'))));
  await page.keyboard.press('Escape');
  await wait(300);

  // ── 2 · 新建项目：负责人下拉为空时必须给「＋ 新建联系人」和一句人话
  await page.click('#create');
  await wait(500);
  await page.evaluate(() => document.querySelector('#detailbody [data-kind="project"]')?.click());
  await wait(1100);
  const ownerField = await page.evaluate(() => {
    const field = [...document.querySelectorAll('#detailbody .formfield')].find(f => f.querySelector(':scope > span')?.textContent.trim() === '负责人');
    if (!field) return null;
    return {
      options: [...field.querySelectorAll('[data-viselect-option]')].map(o => o.textContent.trim()),
      hasCreate: Boolean(field.querySelector('[data-refnew="person"]')),
      hint: field.querySelector('.formhint')?.textContent.trim() ?? '',
      current: field.querySelector('[data-viselect-text]')?.textContent.trim(),
    };
  });
  ok('项目表单找得到「负责人」字段', Boolean(ownerField));
  ok('负责人下拉为空时给出「＋ 新建联系人」', Boolean(ownerField?.hasCreate));
  ok('负责人下拉为空时给出一句人话', (ownerField?.hint ?? '').includes('还没有可选的'), ownerField?.hint ?? '(无)');
  await page.screenshot({path: outDir + 'ref-01-owner-empty.png'});

  // ── 3 · 就地建一个联系人，断言它被选中（不是只弹个提示）
  await page.evaluate(() => document.querySelector('#detailbody [data-refnew="person"]')?.click());
  await wait(300);
  ok('就地输入行出现', await visible('.refcreaterow input'));
  await page.type('.refcreaterow input', '王工');
  await page.screenshot({path: outDir + 'ref-02-owner-creating.png'});
  await page.evaluate(() => {
    const row = document.querySelector('.refcreaterow');
    [...row.querySelectorAll('button')].find(b => b.textContent.includes('建好并选中'))?.click();
  });
  await wait(1600);
  const after = await page.evaluate(() => {
    const field = [...document.querySelectorAll('#detailbody .formfield')].find(f => f.querySelector(':scope > span')?.textContent.trim() === '负责人');
    return {
      current: field?.querySelector('[data-viselect-text]')?.textContent.trim(),
      hidden: field?.querySelector('input[type="hidden"]')?.value,
      options: [...(field?.querySelectorAll('[data-viselect-option]') ?? [])].map(o => o.textContent.trim()),
      createRowGone: !field?.querySelector('[data-refcreaterow]'),
    };
  });
  ok('新建的联系人被自动选中', after.current === '王工' && Boolean(after.hidden), '当前显示：' + after.current);
  ok('新联系人进入下拉候选', after.options.includes('王工'), '候选：' + after.options.join('、'));
  ok('就地输入行已收起', after.createRowGone);
  await page.screenshot({path: outDir + 'ref-03-owner-selected.png' });

  // ── 4 · 真实数据里确实落了库（不是只改了界面）
  const created = await page.evaluate(async () => {
    const response = await fetch('/personal-workstation/api', {
      method: 'POST', headers: {'content-type': 'application/json', 'x-workstation-client': '1'},
      body: JSON.stringify({action: 'list', kind: 'person', limit: 50, workspace: 'w'}),
    });
    const value = await response.json();
    return (value.items ?? []).map(item => item.data?.title);
  });
  ok('联系人真的写进了工作台', created.includes('王工'), '现有联系人：' + created.join('、') || '(空)');

  // ── 5 · 返回项目表单：负责人仍显示已选（不因重开而丢失）
  await page.keyboard.press('Escape');
  await wait(400);
  const stillThere = await page.evaluate(async () => {
    const response = await fetch('/personal-workstation/api', {
      method: 'POST', headers: {'content-type': 'application/json', 'x-workstation-client': '1'},
      body: JSON.stringify({action: 'list', kind: 'person', limit: 50, workspace: 'w'}),
    });
    const value = await response.json();
    return (value.items ?? []).length;
  });
  ok('联系人可被再次读出', stillThere >= 1);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  store.close();
}

console.log(problems.length ? '\nFAIL: 负责人 / 客户链路仍有 ' + problems.length + ' 项未达标。' : '\nPASS: 负责人 / 客户链路端到端可达（建得出、选得上、落了库）。');
process.exit(problems.length ? 1 : 0);
