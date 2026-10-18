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
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

const chrome = chromeExecutable();

const store = new WorkstationStore(':memory:');
const executions = new ExecutionStore(store);
const ctx = {workspace: 'w', actor: 'test', canWrite: true};

// 一条判断（作为建议的依据来源）＋ 一条项目
const seed = store.draft(ctx, {
  title: '建议验收数据',
  changes: [
    {op: 'create', id: 'p-1', kind: 'project', data: {title: '示例科技验证'}},
    {op: 'create', id: 'j-1', kind: 'judgment', data: {
      title: '服务器端短期难以成立', evidence: [{kind: 'message', ref: 'msg-1', quote: '价格敏感是硬约束'}],
      validFrom: '2026-10-11', status: 'current', projectId: 'p-1',
    }},
  ],
});
store.commit(ctx, {batchId: seed.id, revision: 1, key: 'seed'});

// 两条建议：一条用否决，一条用采纳
const adviceA = store.draft(ctx, {
  title: '建议：先索取开发板做零成本适配验证',
  proposal: {
    evidence: [{kind: 'audio', ref: '录音@120-180', quote: '先做零成本技术适配验证', verified: false}],
    uncertainty: '对方是否愿意提供开发板尚未确认',
    basedOn: ['j-1'],
    decision: 'undecided',
  },
  changes: [{op: 'create', id: 't-a', kind: 'task', data: {title: '索取开发板', projectId: 'p-1'}}],
});
const adviceB = store.draft(ctx, {
  title: '建议：同时推进三条客户线',
  proposal: {evidence: [{kind: 'note', ref: 'user-said-1', quote: '要尽快铺开', verified: false}], decision: 'undecided'},
  changes: [{op: 'create', id: 't-b', kind: 'task', data: {title: '铺开三条客户线', projectId: 'p-1'}}],
});

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

  const nav = await page.evaluate(() => document.querySelectorAll('.nav [data-view]').length);
  check('一级入口数量不变（仍 7 个）', nav === 7, '实际 ' + nav);

  await page.evaluate(() => document.querySelector('.nav [data-view="inbox"]').click());
  await new Promise(resolve => setTimeout(resolve, 700));
  const body = await page.evaluate(() => document.querySelector('#inboxbody')?.innerText ?? document.body.innerText);
  check('建议出现在收件箱', body.includes('先索取开发板'), '');
  check('卡上有依据条数', /依据[（(]\s*1\s*条/.test(body), '');
  // 宪章四：依据是给人核对的，不是给人数的 —— 断言依据**原文**真的渲染在卡上。
  // （原来只断言条数，依据一条都不露也算过。）
  const evidenceVisible = await page.evaluate(() => {
   const block = document.querySelector('[data-evidence]');
   if (!block) return {found: false, text: ''};
   const items = [...block.querySelectorAll('.ineitem')].map(node => node.textContent.trim());
   return {found: true, count: items.length, text: items.join('｜')};
  });
  check('依据的原文就摆在卡上（不是只给条数）', evidenceVisible.found && evidenceVisible.count >= 1 && evidenceVisible.text.length > 6, evidenceVisible.text.slice(0, 50));
  check('卡上有不确定性', body.includes('对方是否愿意提供开发板尚未确认'), '');
  check('四个回应都在卡上', ['采纳', '改写', '否决', '稍后'].every(text => body.includes(text)), '');
  // VI §8 V3（2026-10-16 补）：待你决定 = **左侧工作蓝细线 + 文字**「AI 提议 · 等你决定」。
  // 实测原来两样都没有（只有四个按钮）—— 颜色与文字都没承担"这是谁提的、等你做什么"。
  const adviceState = await page.evaluate(() => {
    const card = [...document.querySelectorAll('#inboxbody .inboxcard')].find(el => el.dataset.advice === '1');
    if (!card) return null;
    const cs = getComputedStyle(card);
    return {line: cs.borderLeftWidth + ' ' + cs.borderLeftStyle, color: cs.borderLeftColor, text: card.innerText, decision: card.dataset.decision};
  });
  check('建议卡有左侧工作蓝细线（VI §8 V3）',
    Boolean(adviceState) && parseFloat(adviceState.line) >= 2 && adviceState.line.includes('solid'),
    adviceState ? adviceState.line + ' · ' + adviceState.color : '（没找到建议卡）');
  check('建议卡写明「AI 提议 · 等你决定」（颜色不得单独承担判断）',
    Boolean(adviceState) && /AI 提议/.test(adviceState.text) && /等你决定/.test(adviceState.text),
    adviceState ? adviceState.text.replace(/\s+/g, ' ').slice(0, 60) : '');
  const cardText = await page.evaluate(id => document.querySelector('[data-inboxitem="' + id + '"]')?.innerText ?? '', adviceA.id);
  check('有建议的卡不再显示「同意/不同意」（避免两种模式并存）', !cardText.includes('不同意') && !cardText.includes('同意后才'), cardText.slice(0, 40).replace(/\n/g, ' '));

  // 「为什么这么建议」：有 basedOn 的要能追到具体判断；没有的要**自曝**是通用建议
  await page.evaluate(id => document.querySelector('[data-why="' + id + '"]')?.setAttribute('open', ''), adviceA.id);
  await new Promise(resolve => setTimeout(resolve, 900));
  const chain = await page.evaluate(id => document.querySelector('[data-whychain="' + id + '"]')?.innerText ?? '', adviceA.id);
  check('为什么这么建议能追到你哪条判断', chain.includes('服务器端短期难以成立'), chain.slice(0, 46).replace(/\n/g, ' '));

  await page.evaluate(id => document.querySelector('[data-why="' + id + '"]')?.setAttribute('open', ''), adviceB.id);
  await new Promise(resolve => setTimeout(resolve, 700));
  const chainB = await page.evaluate(id => document.querySelector('[data-whychain="' + id + '"]')?.innerText ?? '', adviceB.id);
  check('没有你判断作支撑的建议会自曝是通用建议', chainB.includes('通用建议'), chainB.slice(0, 46));

  // 否决：就地一行理由 → 卡片留在原位、转灰、显示理由
  await page.evaluate(id => document.querySelector('[data-advice-reject="' + id + '"]')?.click(), adviceA.id);
  await new Promise(resolve => setTimeout(resolve, 250));
  const hasInput = await page.evaluate(id => Boolean(document.querySelector('[data-advice-input="' + id + '"]')?.offsetParent), adviceA.id);
  check('否决就地出现一行理由输入（零跳页）', hasInput);
  const noModal = await page.evaluate(() => !document.querySelector('#veil.open'));
  check('否决没有弹窗（就地完成）', noModal);

  await page.evaluate(id => {
    const input = document.querySelector('[data-advice-input="' + id + '"]');
    input.value = '优先级不对，先看技术再谈商务';
    document.querySelector('[data-advice-send="' + id + '"]').click();
  }, adviceA.id);
  await new Promise(resolve => setTimeout(resolve, 900));

  const after = await page.evaluate(() => document.querySelector('#inboxbody')?.innerText ?? document.body.innerText);
  const stillThere = await page.evaluate(id => Boolean(document.querySelector('[data-inboxitem="' + id + '"]')), adviceA.id);
  check('否决后卡片不消失（留在原位）', stillThere);
  check('卡片转灰（已否决态）', await page.evaluate(id => document.querySelector('[data-inboxitem="' + id + '"]')?.classList.contains('rejected'), adviceA.id));
  check('卡上显示你的理由', after.includes('优先级不对，先看技术再谈商务'), '');
  check('卡上写明不再推荐', after.includes('不再推荐'), '');

  const savedA = store.batch(ctx, adviceA.id);
  check('否决写进去了：状态已取消 + 回应=已否决 + 理由已存', savedA.status === 'cancelled' && savedA.proposal?.decision === 'rejected' && /优先级不对/.test(savedA.proposal?.reason ?? ''), 'status=' + savedA.status + ' decision=' + savedA.proposal?.decision);

  // 采纳：第二条建议
  await page.evaluate(id => document.querySelector('[data-advice-accept="' + id + '"]')?.click(), adviceB.id);
  await new Promise(resolve => setTimeout(resolve, 1200));
  const savedB = store.batch(ctx, adviceB.id);
  check('采纳写进去了：已生效 + 回应=已采纳', savedB.status === 'committed' && savedB.proposal?.decision === 'accepted', 'status=' + savedB.status + ' decision=' + savedB.proposal?.decision);

  // 采纳情况（展开区，不常驻）
  await page.evaluate(() => document.querySelector('[data-proposalstats]')?.setAttribute('open', ''));
  await new Promise(resolve => setTimeout(resolve, 900));
  const stats = await page.evaluate(() => document.querySelector('[data-statsbody]')?.innerText ?? '');
  check('采纳情况用数字（采纳/改写/否决）', /采纳\s*1/.test(stats) && /否决\s*1/.test(stats), stats.slice(0, 60));

  mkdirSync('prototype/screenshots', {recursive: true});
  await page.screenshot({path: 'prototype/screenshots/advice-inbox.png', fullPage: true});
  console.log('截图：prototype/screenshots/advice-inbox.png');
} finally {
  await browser.close();
  server.close();
  store.close();
}
const failed = results.filter(item => !item.ok);
console.log('─'.repeat(56));
console.log(failed.length ? `FAIL: ${failed.length} 项未通过` : `PASS: ${results.length} 项全部通过（真实浏览器 + 建议数据）`);
process.exit(failed.length ? 1 : 0);
