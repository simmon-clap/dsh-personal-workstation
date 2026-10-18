/** 批次 4 验收：建议卡的四个回应在**真实浏览器**里走通，且否决后卡片不消失。
 *
 *  验收标准（spec/04 批次 4）：零跳页完成四回应；否决理由一句话即可提交；否决卡不消失留在原位。
 *  用法：node prototype/advice-browser-check.mjs —— 一次性内存库，不碰生产数据。 */
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {ExecutionStore} from '../src/execution-store.mjs';
import {seedVisualStore} from './visual-seed.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

const chrome = chromeExecutable();

const store = new WorkstationStore(':memory:');
const executions = new ExecutionStore(store);
const ctx = {workspace: 'w', actor: 'test', canWrite: true};

// 批次 6（F16 / F17）验收：导出一份文档，收件人无需解释就能看懂
// "哪条是谁在何时判断、依据是什么"；且只分享标了「可以给同事看」的，剔除项被明示。
function seedJudgment(id, title, share, quote) {
  // share 允许**不传**：宪章/交互律要求「默认不写 share 就按仅自己处理」，
  // 所以这里必须真的有一条没写 share 的记录，才能把这条约定验成行为而不是写死 true（45 审计抓到的假绿）。
  const data = {
    title, validFrom: '2026-10-11', reviewBy: '2026-11-11', status: 'current',
    uncertainty: '成本口径还没确认',
    evidence: [{kind: 'audio', ref: '录音@120-180', quote, verified: false}],
  };
  if (share !== undefined) data.share = share;
  const batch = store.draft(ctx, {title: '判断 ' + id, changes: [{op: 'create', id, kind: 'judgment', data}]});
  store.commit(ctx, {batchId: batch.id, revision: 1, key: 'j-' + id});
}
seedJudgment('j-team', '服务器端短期难以成立', 'team', '先做零成本技术适配验证');
seedJudgment('j-private', '合资垫资长期有风险', 'private', '合资加垫资绑地方政府财政');
// 没写 share 的那一条：用来验证「默认按仅自己处理」不是一句注释。
seedJudgment('j-default', '默认可见性判断：这条没有写谁能看', undefined, '没写 share 的记录');

const connection = {admit: () => ({peer: {id: 'operator'}}), requestRejection: () => undefined};
const route = httpRoute({
  store, executions, connection,
  workspaceRegistry: {list: () => [{id: 'w', title: '个人空间'}], get: id => (id === 'w' ? {id: 'w'} : null)},
  allowedWorkspaces: ['w'],
});
const server = createServer((request, response) => route.handler(request, response));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const browser = await puppeteer.launch({executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']});
const results = [];
const check = (label, ok, detail = '') => { results.push({label, ok}); console.log((ok ? 'PASS' : 'FAIL').padEnd(5) + label + (detail ? '  → ' + detail : '')); };
try {
  const page = await browser.newPage();
  await page.setViewport({width: 1440, height: 960});
  await page.goto('http://127.0.0.1:' + port + '/personal-workstation', {waitUntil: 'networkidle0'});
  await page.evaluate(() => document.querySelector('.nav [data-view="knowledge"]').click());
  await new Promise(resolve => setTimeout(resolve, 700));

  const body = await page.evaluate(() => document.querySelector('#knowbody')?.innerText ?? '');
  check('判断卡上逐条显示谁能看', body.includes('可以给同事看') && body.includes('仅自己'), '');
  const defaultCard = await page.evaluate(() => [...document.querySelectorAll('#knowbody [data-id]')]
    .map(node => node.innerText.replace(/\s+/g, ' ')).find(text => text.includes('默认可见性判断')) ?? '');
  check('默认不写 share 的记录按「仅自己」处理',
    defaultCard.includes('仅自己') && store.get(ctx, 'j-default')?.data?.share === undefined,
    '卡片=' + defaultCard.slice(0, 40) + ' · 存储 share=' + store.get(ctx, 'j-default')?.data?.share);

  // 点「导出判断」→ 先给数量预览，不直接下载
  await page.evaluate(() => document.querySelector('[data-know-act="export"]')?.click());
  await new Promise(resolve => setTimeout(resolve, 400));
  const preview = await page.evaluate(() => document.querySelector('[data-exportpreview]')?.innerText ?? '');
  check('导出前显示将分享与剔除数量（F17 硬要求）', /将分享\s*1\s*条/.test(preview) && /剔除\s*2\s*条仅自己/.test(preview), preview.trim());
  check('预览阶段没有直接下载', await page.evaluate(() => !window.__exported));

  // 捕获下载内容
  await page.evaluate(() => {
    window.__exported = null;
    const original = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => { blob.text().then(text => { window.__exported = text; }); return original(blob); };
  });
  await page.evaluate(() => document.querySelector('[data-exportgo]')?.click());
  await new Promise(resolve => setTimeout(resolve, 800));
  const doc = await page.evaluate(() => window.__exported ?? '');
  check('确实产出了文档', doc.length > 80, doc.length + ' 字');
  check('文档写明「谁在何时判断」', /谁在何时判断/.test(doc), '');
  // 判据 6（2026-10-16）：文档是给**别人**看的 —— 出现 UUID 或内部编号就等于没翻译。
  const docText = await page.evaluate(() => document.querySelector('#knowbody [data-kxport="1"]')?.textContent ?? '');
  check('导出预览里不出现内部编号或 UUID', !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b(?:j|proj|art|ev|topic|task|rel|voice)-[a-z0-9-]{4,}/i.test(docText), docText.slice(0, 90));

  check('「谁」用了真实记录人（就是写入者，不是编的）', doc.includes(ctx.actor), '记录人=' + ctx.actor);
  // 意图不变（文档必须带"出处与原文"），但**格式按判据 6 改了**：
  // 原来断言的是裸出处 `录音@120-180` —— 那正是"把内部编号摆给读者"的写法。
  // 现在要求：原文在、出处说人话（解析得到标题就用标题，带段落范围的写成"第 N–M 段"），
  // 且**不许**再出现裸编号或 `@` 范围写法。
  check('文档带依据出处与原文（出处已翻译成人话）',
    doc.includes('先做零成本技术适配验证')
    && /出处：/.test(doc)
    && !/录音@120-180/.test(doc)
    && !/\b(?:j|proj|art|ev|topic|task|rel|voice)-[a-z0-9-]{4,}/i.test(doc),
    doc.split('\n').filter(line => /出处：/.test(line)).slice(0, 1).join('').slice(0, 90));
  check('文档带不确定性', doc.includes('成本口径还没确认'), '');
  check('文档写明剔除了几条仅自己', /已剔除 2 条标为「仅自己」/.test(doc), doc.split('\n').filter(line => /剔除/.test(line))[0]?.slice(0, 60) ?? '');
  check('仅自己的判断没有泄漏进文档', !doc.includes('合资垫资长期有风险'), '');
  // 同上：时间也要说人话（原来断言 ISO 的 `T`，读者不需要看毫秒与时区后缀）。
  check('文档自带导出时间（人话格式）', /导出时间 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(doc) && !/\d{4}-\d{2}-\d{2}T\d/.test(doc), '');

  // 详情里一键切换谁能看（自己的操作，直接生效）
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('#knowbody [data-id]')].find(n => n.innerText.includes('合资垫资长期有风险'));
    card?.click();
  });
  await new Promise(resolve => setTimeout(resolve, 600));
  const before = await page.evaluate(() => document.querySelector('#judgmentshare')?.textContent ?? '');
  await page.evaluate(() => document.querySelector('#judgmentshare')?.click());
  await new Promise(resolve => setTimeout(resolve, 900));
  const after = await page.evaluate(() => document.querySelector('#judgmentshare')?.textContent ?? '');
  check('详情里一键切换谁能看', before.includes('仅自己') && after.includes('可以给同事看'), before + ' → ' + after);
  check('切换真的写进了存储', store.get(ctx, 'j-private')?.data?.share === 'team', 'share=' + store.get(ctx, 'j-private')?.data?.share);

  mkdirSync('prototype/screenshots', {recursive: true});
  await page.screenshot({path: 'prototype/screenshots/judgment-export.png'});
  console.log('截图：prototype/screenshots/judgment-export.png');
} finally {
  await browser.close();
  server.close();
  store.close();
}
const failed = results.filter(item => !item.ok);
console.log('─'.repeat(56));
console.log(failed.length ? `FAIL: ${failed.length} 项未通过` : `PASS: ${results.length} 项全部通过（真实浏览器 + 导出）`);
process.exit(failed.length ? 1 : 0);
