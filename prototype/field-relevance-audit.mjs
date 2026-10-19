/** 字段相关性门禁：**信息密，但不是无关信息的多**（用户 2026-10-14 原话）。
 *
 *  判据（从宪章推出，不是我的口味）：
 *    ① 一个详情面里的每个字段，必须属于「**这个对象当前要做的决定**」所需
 *       —— 宪章六「克制：新元素必须证明无法被现有元素表达」+ 交互律 01「人只在分叉点出现」。
 *    ② 来源 / 编号 / 指纹 / 版本 这类**账目信息**只在两种情况下上屏：
 *       · 它本身就是要判断的对象（判断、记忆引用 —— 宪章第三条把依据列为一等公民）；
 *       · 它处于**要你处理的状态**（同步冲突、核对失败、未接入）。
 *       其余情况默认收起、可点开（宪章七「可读」+ VI §4「一块内容最多两层容器嵌套」）。
 *    ③ 值必须说人话：不出现 MIME（text/markdown）、裸 id、undefined、[object Object]（宪章七「可读」）。
 *
 *  为什么要有它：用户点开日历里的一天，看到的是「外部事件 ID / 最近同步 / 内容指纹」，
 *  而他想看的是「和谁、聊什么、什么时候、在哪」。这类"账目信息挤占正文"的问题
 *  在项目、任务、资料上同样存在 —— 靠人肉看是查不完的，必须机械扫。
 *
 *  用法：node prototype/field-relevance-audit.mjs
 */
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {ExecutionStore} from '../src/execution-store.mjs';
import {seedVisualStore} from './visual-seed.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

const chrome = chromeExecutable();

/** 账目信息标签：这些只在判断/记忆引用上常驻，其余对象必须折进可展开区。 */
const BOOKKEEPING = /^(外部来源|外部事件 ID|外部事件ID|最近同步|内容指纹|文件授权|文件版本|来源引用|文档|知识库|编号|指纹|同步|修订|版本|provider|reference|id)$/i;
/** 值层面的机器话。 */
const MACHINE_VALUE = /^(text\/|image\/|application\/|audio\/|video\/)|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|^\s*undefined\s*$|\[object Object\]|^(proj|task|dir|evt|art)-[0-9a-z]/i;
/** 裸时间戳也是机器话：`2026-10-12T10:30:00+08:00` 对用户就是编码（用户 2026-10-14 原话）。
 *  这一条是本门禁第一版**漏掉**的 —— 第一版只查了 id 与 MIME，结果它对着一个
 *  明显显示 ISO 串的界面报了 PASS。门禁要能抓住"已经坏掉的界面"，否则等于没有。 */
const RAW_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|^\d{13}$|\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}/;

const store = new WorkstationStore(':memory:');
const executions = new ExecutionStore(store);
seedVisualStore(store);
// 造一条**带外部同步账目**的日程：用户点开日历看到"外部事件 ID / 内容指纹"就是这一类。
store.draft({workspace: 'w', actor: 'field', canWrite: true}, {
  title: '带同步账目的日程',
  changes: [{
    op: 'create', id: 'evt-sync', kind: 'event',
    data: {
      title: '与示例客户董事长会面', eventType: 'meeting', location: '线上会议',
      startDate: '2026-10-20 10:30', endDate: '2026-10-20 11:30', timezone: 'Asia/Shanghai',
      externalSource: 'apple-calendar', externalUid: 'A1B2C3D4-5E6F-7890-ABCD-EF1234567890',
      externalSyncedAt: '2026-10-14T02:00:00.000Z', externalFingerprint: 'sha256:9f2c1a7b',
      sourceRefs: ['session:abc123'],
    },
  }, {
    op: 'create', id: 'art-sync', kind: 'artifact',
    data: {
      title: '会议纪要', path: '会议/纪要.md', mime: 'text/markdown', fileGrantId: 'voice-inbox',
      fileVersion: 'v3', knowledgeDocId: '00000000-0000-4000-8000-000000000001',
      knowledgeBaseId: '00000000-0000-4000-8000-000000000002', knowledgeUpdatedAt: '2026-10-12T00:00:00.000Z',
      sourceRefs: ['session:abc123'], content: '要点',
    },
  }],
});
const connection = {admit: () => ({peer: {id: 'field'}}), requestRejection: () => undefined};
const route = httpRoute({
  store, executions, connection,
  workspaceRegistry: {list: () => [{id: 'w', title: '个人空间'}], get: () => ({id: 'w'})},
  allowedWorkspaces: ['w'],
  files: {grants: [{id: 'voice-inbox', workspace: 'w', root: process.cwd(), read: true, write: false, label: '语音目录（只读）'}]},
});
const server = createServer((request, response) => route.handler(request, response));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const browser = await puppeteer.launch({executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']});
const page = await browser.newPage();
await page.setViewport({width: 1440, height: 940});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const problems = [];
const opened = [];

/** 打开一个对象详情，返回它**可见**的字段行（不含收起的账目区）。 */
async function inspect(label, open) {
  await page.goto('http://127.0.0.1:' + server.address().port + '/personal-workstation', {waitUntil: 'networkidle0'});
  await page.waitForFunction(() => document.querySelectorAll('#projectstrip [data-project]').length > 0, {timeout: 15000});
  await wait(500);
  await open();
  await wait(900);
  const state = await page.evaluate(() => {
    const veil = document.querySelector('#veil');
    if (!veil?.classList.contains('open')) return null;
    const body = document.querySelector('#detailbody');
    const visible = [];
    for (const node of body.querySelectorAll('p')) {
      if (node.closest('details:not([open])')) continue;          // 收起区里的不算"上屏"
      if (node.closest('[data-bookkeeping]') && !node.closest('details[open]')) continue;
      const text = (node.textContent || '').trim();
      const match = text.match(/^([^：]{1,12})：(.+)$/);
      if (match) visible.push([match[1], match[2]]);
    }
    return {kind: document.querySelector('#detailtype')?.textContent?.trim(), title: document.querySelector('#detailtitle')?.textContent?.trim(), visible,
      hasBookkeeping: Boolean(body.querySelector('[data-bookkeeping]'))};
  });
  if (!state) { problems.push(label + '：详情没打开（门禁自己都打不开就不算数）'); return null; }
  opened.push(label + '（' + state.kind + '）');
  const provenanceOk = /判断|记忆引用/.test(state.kind ?? '');
  for (const [name, value] of state.visible) {
    if (BOOKKEEPING.test(name) && !provenanceOk) problems.push(label + '：账目字段「' + name + '」直接上了正文（应折进可展开区）');
    const raw = String(value).trim();
    if (MACHINE_VALUE.test(raw)) problems.push(label + '：值不像人话 → ' + name + '：' + raw.slice(0, 40));
    if (RAW_TIMESTAMP.test(raw)) problems.push(label + '：时间没翻译成人话 → ' + name + '：' + raw.slice(0, 40));
  }
  return state;
}

try {
  await inspect('日程详情', async () => {
    await page.evaluate(() => document.querySelector('.nav [data-view="personal"]')?.click());
    await wait(600);
    await page.evaluate(() => document.querySelector('#personalbody [data-id]')?.click());
  });
  await inspect('资料详情', async () => {
    await page.evaluate(() => document.querySelector('.nav [data-view="knowledge"]')?.click());
    await wait(500);
    await page.evaluate(() => document.querySelector('#knowtabs [data-know="files"]')?.click());
    await wait(600);
    await page.evaluate(() => document.querySelector('#knowbody [data-id]')?.click());
  });
  await inspect('项目详情', async () => {
    await page.evaluate(() => document.querySelector('.nav [data-view="projects"]')?.click());
    await wait(600);
    await page.evaluate(() => document.querySelector('#projectsbody [data-project]')?.click());
  });
  await inspect('任务详情', async () => {
    await page.evaluate(() => document.querySelector('.nav [data-view="tasks"]')?.click());
    await wait(600);
    await page.evaluate(() => document.querySelector('#tasksbody [data-task]')?.click());
  });
  await inspect('判断详情', async () => {
    await page.evaluate(() => document.querySelector('.nav [data-view="knowledge"]')?.click());
    await wait(500);
    await page.evaluate(() => document.querySelector('#knowtabs [data-know="topics"]')?.click());
    await wait(600);
    await page.evaluate(() => document.querySelector('#knowbody [data-id]')?.click());
  });

  // 收件箱卡：同样的相关性判据（用户 2026-10-14：「信息密，但不是无关信息的多」）。
  // 「来自：未记录」这类**未知占位符**不构成信息 —— 你没法据此做任何决定，它只占一行。
  await page.goto('http://127.0.0.1:' + server.address().port + '/personal-workstation', {waitUntil: 'networkidle0'});
  await page.waitForFunction(() => document.querySelectorAll('#projectstrip [data-project]').length > 0, {timeout: 15000});
  await page.evaluate(() => document.querySelector('.nav [data-view="inbox"]')?.click());
  await wait(1000);
  // 看「全部」而不是默认的「待确认」：这条判据问的是"卡上有多少无关信息"，
  // 跟这张卡属于哪个状态无关（夹具那条草稿被判成"需补充/冲突"，默认页签里根本看不到）。
  await page.evaluate(() => [...document.querySelectorAll('#inboxfilters [data-inbox]')].find(node => node.textContent.trim() === '全部')?.click());
  await wait(1200);
  // 先确认**真的有卡片可查**：查不到卡就等于这条判据什么都没量，必须报出来，不能算过。
  // （同一个教训：门禁对着"没有东西可查"的界面报绿，等于没有门禁。）
  const cardCount = await page.evaluate(() => document.querySelectorAll('.inboxcard').length);
  if (!cardCount) problems.push('收件箱卡：这一轮没有卡片可查，判据等于没量（夹具没造出待确认的改动）');
  const cardNoise = await page.evaluate(() => {
    const out = [];
    for (const card of document.querySelectorAll('.inboxcard')) {
      for (const line of card.querySelectorAll('p, span, em')) {
        if (line.children.length && !line.matches('p')) continue;
        const text = (line.textContent || '').trim();
        // 「标签：未记录 / 未知 / 无」——未知占位符当信息写
        if (/^[^：]{1,8}：(未记录|未知|无|未设置)$/.test(text)) out.push(text);
      }
    }
    return [...new Set(out)];
  });
  for (const line of cardNoise) problems.push('收件箱卡：未知占位符当信息写 → ' + line);

  // VI §2「颜色不得单独承担判断」：每个状态点旁边**必须有文字**。
  // 注意这条我第一版写反了：我本意是查"状态词重复"，结果把"色点 + 文字"这个**合规**的写法
  // 报成了违规，而且和另一道门禁（要求色点旁必须有文字）直接打架。判据写反了就得改回来。
  const dotsWithoutText = await page.evaluate(() => {
    const words = ['待确认', '需补充/冲突', '已处理', '已取消'];
    const out = [];
    for (const card of document.querySelectorAll('.inboxcard')) {
      const text = card.innerText || '';
      for (const dot of card.querySelectorAll('.statusdot')) {
        if (!words.some(word => text.includes(word))) {
          out.push('状态点 data-state="' + (dot.dataset.state ?? '?') + '" 旁边没有任何状态文字');
        }
      }
    }
    return [...new Set(out)];
  });
  for (const line of dotsWithoutText) problems.push('收件箱卡：状态只靠颜色表达 → ' + line);

} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  store.close();
}

console.log('字段相关性门禁：实际打开了 ' + opened.length + ' 个详情 —— ' + opened.join('、'));
if (problems.length) {
  console.log('');
  for (const problem of problems) console.log('  ⚠ ' + problem);
  console.log('\nFAIL: ' + problems.length + ' 处无关信息占用了正文（判据：宪章六「克制」+ 交互律 01；账目信息只在判断/记忆引用上常驻）。');
} else {
  console.log('PASS: 详情正文里没有账目信息（来源/编号/指纹/版本）挤占，值也都是人话。');
}
process.exit(problems.length ? 1 : 0);
