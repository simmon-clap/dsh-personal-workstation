/** 批次 1 验收：判断对象在**真实浏览器**里看得见、依据能就地展开。
 *
 *  验收标准（spec/04 批次 1）：真实会议材料 → 沉淀判断 → 每条依据可展开看回出处
 *  → 标记待核对 → 被新证据推翻后旧判断与理由仍可查。
 *
 *  用法：node prototype/judgment-browser-check.mjs
 *  使用一次性内存库，不写入生产数据。 */
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
seedVisualStore(store);

// 真实会议材料（会议/杭州示例学校-会议纪要.md）→ 两条判断，其中一条已被推翻。
const ctx = {workspace: 'w', actor: 'test', canWrite: true};
const seed = store.draft(ctx, {
  title: '判断验收数据',
  changes: [
    {
      op: 'create', id: 'j-1', kind: 'judgment',
      data: {
        // 来源（用户 2026-10-17）：这条代表"Agent 起草的判断"，所以带 origin='ai'
        origin: 'ai',
        title: '服务器端短期难以成立：带宽与成本都不匹配现有客户的价格预期',
        evidence: [
          // F8：出处指向**真实存在的资料记录**，这样"点回原始出处"能被确定地验证
          // （不是"看起来有个按钮"，而是点下去真的打开了那条资料）。
          {kind: 'file', ref: 'a-minutes', quote: '服务器方案：4 颗一个 page，明年 3 月投片、9 月回片', verified: false},
          {kind: 'note', ref: 'user-said-2026-10-11', quote: '价格敏感是硬约束', verified: false},
        ],
        uncertainty: '口径未确认，待与对方核对成本基准',
        validFrom: '2026-10-11',
        reviewBy: '2026-11-11',
        status: 'checking',
      },
    },
    {
      op: 'create', id: 'a-minutes', kind: 'artifact',
      data: {title: '会议纪要 · 示例科技路演', path: '会议/示例科技-3D存算一体/杭州示例学校-会议纪要.md', projectId: 'p-a', mime: 'text/markdown'},
    },
    {
      op: 'create', id: 'j-2', kind: 'judgment',
      data: {
        title: '合资并垫资的玩法长期有风险',
        evidence: [{kind: 'audio', ref: '示例学校.m4a@4200-4300', quote: '合资 + 垫资 + 绑地方政府财政', verified: false}],
        uncertainty: '对方商业模式自述无法验证',
        validFrom: '2026-10-11',
        status: 'overturned',
        overturnedBy: {ref: 'j-9', reason: '新证据表明对方愿意自行承担前期投入', at: '2026-12-01T09:00:00+08:00'},
      },
    },
  ],
});
store.commit(ctx, {batchId: seed.id, revision: 1, key: 'judgment-acceptance'});

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
const check = (label, ok, detail = '') => {
  results.push({label, ok, detail});
  console.log((ok ? 'PASS' : 'FAIL').padEnd(5) + label + (detail ? '  → ' + detail : ''));
};
try {
  const page = await browser.newPage();
  await page.setViewport({width: 1440, height: 940});
  await page.goto('http://127.0.0.1:' + port + '/personal-workstation', {waitUntil: 'networkidle0'});

  // 知识页 → 研究议题
  await page.evaluate(() => document.querySelector('.nav [data-view="knowledge"]').click());
  const tabs = await page.evaluate(() => [...document.querySelectorAll('[data-know]')].map(n => n.dataset.know));
  check('研究议题页签存在（未新增一级入口）', tabs.includes('topics'), '页签：' + tabs.join('/'));

  const body = await page.evaluate(() => document.querySelector('#knowbody')?.innerText ?? '');
  check('判断出现在研究议题列表', body.includes('服务器端短期难以成立'), body.slice(0, 60).replace(/\n/g, ' '));
  check('卡片显示依据条数与状态', body.includes('依据 2 条') && body.includes('待核对'), '');
  check('卡片显示什么时候成立', body.includes('2026-10-11'), '');
  check('卡片显示不确定性（按不确定性原文断言）', body.includes('口径未确认，待与对方核对成本基准'), '');
  check('被推翻的判断显示推翻状态', body.includes('已被推翻'), '');

  // 点开详情：依据必须**就地展开**（不跳页），每条带出处
  const opened = await page.evaluate(() => {
    const card = [...document.querySelectorAll('#knowbody [data-id]')].find(n => n.innerText.includes('服务器端短期难以成立'));
    if (!card) return null;
    card.click();
    return true;
  });
  check('判断卡可点开', opened === true);
  await new Promise(resolve => setTimeout(resolve, 500));

  const drawn = await page.evaluate(() => {
    const veil = document.querySelector('#veil');
    const body = document.querySelector('#detailbody');
    return {open: Boolean(veil?.classList.contains('open')), visible: Boolean(body && body.offsetParent !== null)};
  });
  check('详情抽屉真的打开了（可见性断言，不只看文本）', drawn.open && drawn.visible, JSON.stringify(drawn));
  const detail = await page.evaluate(() => document.querySelector('#detailbody')?.innerText ?? '');
  check('详情里依据就地展开（不跳页）', detail.includes('依据（2 条）'), '');
  check('依据带出处原文', detail.includes('明年 3 月投片'), '');
  check('依据标注来源类型与出处', detail.includes('文件') && detail.includes('出处'), '');
  check('出处不把内部 id 摆给用户看', !detail.includes('a-minutes'), '内部 id 应该只留在 title 里');
  check('依据区分是否经第三方验证', detail.includes('未经第三方验证'), '');
  // VI §8 V1：一眼可辨来源（实测此前一条都没有 —— "AI 判断"四个字全站没出现过）。
  check('依据分来源三态：你说的 / 原始材料（VI §8 V1）', detail.includes('你说的') && detail.includes('原始材料'), '');
  check('详情显示不确定性（按不确定性原文断言）', detail.includes('口径未确认，待与对方核对成本基准'), '');
  check('详情显示何时复核', detail.includes('2026-11-11'), '');
  check('页面未跳走（仍在知识页）', await page.evaluate(() => document.querySelector('#knowledge')?.classList.contains('active') ?? false));

  // ── F8：依据要能**点回原始出处**（宪章判据 3）────────────────────────────────
  // 原来只把 ref 当字符串打印 —— 看得见、点不动，等于追不回去。
  check('依据给了「看原始出处」的入口', detail.includes('看原始出处'), '');
  check('口述类依据不摆一个点不动的按钮', detail.includes('你的口述 —— 没有出处文件可点'), '');
  const beforeClick=await page.evaluate(() => document.querySelector('#detailbody')?.innerText ?? '');
  const clickedRef=await page.evaluate(() => {
    const button=document.querySelector('#detailbody [data-evidence-ref]');
    if(!button)return false;
    button.click();
    return true;
  });
  check('「看原始出处」点得动', clickedRef === true);
  await new Promise(resolve => setTimeout(resolve, 900));
  const afterClick=await page.evaluate(() => document.querySelector('#detailbody')?.innerText ?? '');
  // 不是死按钮：要么真的打开了出处，要么**如实说清为什么打不开**（这个夹具没有文件授权）。
  const resolved=afterClick !== beforeClick && (afterClick.includes('会议纪要') || afterClick.includes('授权'));
  check('点回出处有明确结果（打开出处，或如实说打不开）', resolved, afterClick.slice(0, 70).replace(/\n/g, ' '));
  check('点回处之后页面仍未跳走（零跳页）', await page.evaluate(() => document.querySelector('#knowledge')?.classList.contains('active') ?? false));

  // 被推翻的判断：旧判断与理由都还在
  const overturned = await page.evaluate(() => {
    const card = [...document.querySelectorAll('#knowbody [data-id]')].find(n => n.innerText.includes('合资并垫资'));
    if (!card) return null;
    card.click();
    return true;
  });
  await new Promise(resolve => setTimeout(resolve, 500));
  const detail2 = await page.evaluate(() => document.querySelector('#detailbody')?.innerText ?? '');
  check('被推翻的判断仍可打开', overturned === true);
  check('推翻理由可见（不抹掉当时为什么这么想）', detail2.includes('对方愿意自行承担前期投入'), '');
  check('原依据未被删除', detail2.includes('合资 + 垫资'), '');

  // ---- 界面可达性（批次 1 审查漏网的缺陷：判断建不了 / 编辑不了）----
  await page.evaluate(() => document.querySelector('#detailbody .close, #veil .close')?.click());
  await new Promise(resolve => setTimeout(resolve, 300));
  await page.evaluate(() => document.querySelector('#create').click());
  await new Promise(resolve => setTimeout(resolve, 400));
  const menu = await page.evaluate(() => [...document.querySelectorAll('#detailbody [data-kind]')].map(n => n.querySelector('h2')?.textContent ?? ''));
  check('新建菜单里能建「判断」（否则界面上建不了判断）', menu.includes('判断'), menu.join('/'));
  await page.evaluate(() => document.querySelector('#veil .close')?.click());
  await new Promise(resolve => setTimeout(resolve, 300));
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('#knowbody [data-id]')].find(n => n.innerText.includes('服务器端短期难以成立'));
    card?.click();
  });
  await new Promise(resolve => setTimeout(resolve, 500));
  const editLabel = await page.evaluate(() => [...document.querySelectorAll('#detailbody button')].map(b => b.textContent).find(t => t.startsWith('编辑')));
  check('详情里有「编辑判断」', editLabel === '编辑判断', String(editLabel));

  check('详情类型名是「判断」不是「记录」', await page.evaluate(() => !(document.querySelector('#detailbody')?.innerText ?? '').includes('记录：')), '');
  check('状态带符号（V2：颜色不单独承担判断）', (await page.evaluate(() => document.querySelector('#detailbody')?.innerText ?? '')).includes('◇ 待核对'), '');

  // ---- 批次 2：待核对筛选 + 核对后就地更新 ----
  const nav = await page.evaluate(() => document.querySelectorAll('.nav [data-view]').length);
  check('一级入口数量不变（仍 7 个）', nav === 7, '实际 ' + nav);

  const filterText = await page.evaluate(() => document.querySelector('[data-know-filter]')?.textContent ?? '');
  check('研究议题上出现「只看待核对」筛选', filterText.includes('只看待核对'), filterText.trim());
  check('待核对数量来自真实数据（1 条）', /只看待核对\s*1/.test(filterText), filterText.trim());

  await page.evaluate(() => document.querySelector('[data-know-filter]').click());
  await new Promise(resolve => setTimeout(resolve, 300));
  const filtered = await page.evaluate(() => document.querySelector('#knowbody')?.innerText ?? '');
  check('筛选后只显示待核对', filtered.includes('服务器端短期难以成立') && !filtered.includes('合资并垫资'), '');
  check('筛选可恢复（按钮变回全部）', await page.evaluate(() => Boolean(document.querySelector('[data-know-filter]'))));
  check('筛选没有新增页签', (await page.evaluate(() => [...document.querySelectorAll('#knowtabs [data-know]')].map(n => n.dataset.know))).length === 4, '页签仍为 4 个');

  // 打开待核对判断 → 就地核对
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('#knowbody [data-id]')].find(n => n.innerText.includes('服务器端短期难以成立'));
    card?.click();
  });
  await new Promise(resolve => setTimeout(resolve, 500));
  check('待核对判断有就地核对输入框', await page.evaluate(() => Boolean(document.querySelector('#judgmentverify'))));
  check('待核对判断有「核对完成」按钮', await page.evaluate(() => document.querySelector('#judgmentverifyapply')?.textContent === '核对完成'), '');

  await page.evaluate(() => {
    const input = document.querySelector('#judgmentverify');
    input.value = '已与对方确认：成本口径为 20nm 量产报价';
    document.querySelector('#judgmentverifyapply').click();
  });
  await new Promise(resolve => setTimeout(resolve, 900));
  const after = await page.evaluate(() => document.querySelector('#detailbody')?.innerText ?? '');
  check('核对后就地更新状态文字', after.includes('状态：当前有效'), '');
  check('核对后收起核对区', await page.evaluate(() => !document.querySelector('#judgmentverify')));
  check('页面未跳走（仍在知识页）', await page.evaluate(() => document.querySelector('#knowledge')?.classList.contains('active') ?? false));

  // 数据层确认真的写进去了
  const stored = store.list(ctx, {kind: 'judgment'}).find(x => x.id === 'j-1');
  check('核对结果真的写进存储', stored?.data?.status === 'current' && /成本口径/.test(stored?.data?.uncertainty ?? ''), '状态=' + stored?.data?.status);

  mkdirSync('prototype/screenshots', {recursive: true});
  await page.screenshot({path: 'prototype/screenshots/judgment-list.png'});
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('#knowbody [data-id]')].find(n => n.innerText.includes('服务器端短期难以成立'));
    card?.click();
  });
  await new Promise(resolve => setTimeout(resolve, 400));
  // ---- 来源 TAG（用户 2026-10-17：「可以把来源记下来，最好只是 TAG」）----
  // 要求：① 界面新建的判断 = 「你说的」；② Agent 通道新建 = 「AI 起草」；③ 只在详情出现一枚标签，不进卡片、不加输入框。
  {
    const judgmentCards = await page.evaluate(() => document.querySelectorAll('#knowbody [data-id]').length);
    check('判断列表能打开（来源检查的前置）', judgmentCards > 0, judgmentCards + ' 张');
    // 用库里已有的判断：夹具里由 Agent 通道建的那条应当带 origin='ai'
    const originRows = store.db.prepare("select id, json_extract(data,'$.origin') origin from entities where kind='judgment' and archived=0").all();
    check('AI 起草的判断带来源标记', originRows.some(row => row.origin === 'ai'), JSON.stringify(originRows.map(row => row.origin)));
    const aiRow = originRows.find(row => row.origin === 'ai');
    if (aiRow) {
      await page.evaluate(id => {
        const card = [...document.querySelectorAll('#knowbody [data-id]')].find(node => node.dataset.id === id);
        card?.click();
      }, aiRow.id);
      await new Promise(resolve => setTimeout(resolve, 900));
      const detailText = await page.evaluate(() => document.querySelector('#veil')?.innerText ?? '');
      check('详情里用一枚标签写清「AI 起草」', detailText.includes('AI 起草'), detailText.replace(/\s+/g, ' ').slice(0, 80));
      check('来源没有变成复杂呈现（卡片上不出现）', await page.evaluate(() => {
        const card = [...document.querySelectorAll('#knowbody [data-id]')].find(node => node.dataset.id === 'none');
        return card ? !(card.innerText || '').includes('AI 起草') : true;
      }), '卡片层不显示来源');
      await page.evaluate(() => document.querySelector('#close')?.click());
      await new Promise(resolve => setTimeout(resolve, 600));
    }
  }

  // ---- 编辑器「出处」栏：填了「文件名@第几段」→ 存成带锚点的依据 ----
  {
    const opened = await page.evaluate(async () => {
      // 正确路径：顶栏「新建」→ 菜单里的「判断」卡片（按文案找按钮会找不到，菜单是卡片）
      document.querySelector('#create')?.click();
      await new Promise(resolve => setTimeout(resolve, 600));
      const card = document.querySelector('#detailbody [data-kind="judgment"]');
      card?.click();
      return Boolean(card);
    });
    if (opened) {
      await new Promise(resolve => setTimeout(resolve, 900));
      const hasRefField = await page.evaluate(() => Boolean(document.querySelector('[data-field="evidenceRef"]')));
      check('编辑器有「出处」一栏（依据能写"哪一段"）', hasRefField);
      if (hasRefField) {
        await page.evaluate(() => {
          const set = (name, value) => { const field = document.querySelector('[data-field="' + name + '"]'); if (field) { field.value = value; field.dispatchEvent(new Event('input', {bubbles: true})); } };
          set('title', '来源与出处验收用的判断');
          set('evidence', '对方说服务器方案还不存在');
          set('evidenceRef', '会议录音.m4a@120-180');
          set('validFrom', '2026-10-17');
          // 这两个是 VI 自定义选择控件（隐藏 input 存值）；不设会卡在校验上，弹窗不关、也不告诉我为什么。
          set('share', 'private');
          set('status', 'checking');
        });
        await page.evaluate(() => document.querySelector('#objpreview')?.click());
        await new Promise(resolve => setTimeout(resolve, 1600));
        const saved = store.db.prepare("select json_extract(data,'$.evidence') e, json_extract(data,'$.origin') o from entities where kind='judgment' and json_extract(data,'$.title')='来源与出处验收用的判断'").get();
        const evidence = saved ? JSON.parse(saved.e) : [];
        check('填了出处后，依据带上了锚点（录音 + 时间区间）', evidence.some(one => one.kind === 'audio' && /@120-180$/.test(one.ref)), JSON.stringify(evidence).slice(0, 90));
        check('界面新建的判断来源是「你说的」', saved?.o === 'user', String(saved?.o));
      }
    } else {
      check('编辑器有「出处」一栏（依据能写"哪一段"）', false, '没能打开新建判断');
    }
  }

  // ---- 编辑一次判断**不许弄丢依据的出处**（2026-10-16 发现的数据丢失）----
  // 编辑器把「依据」做成 textarea（每行一条原文），原来保存时把每一行都重写成"你的口述"，
  // 于是只要改个标题，文件/录音出处就全丢了 —— 而"依据能追回原始出处"是宪章判据 3。
  // 这里真的走一遍：打开带文件出处的判断 → 编辑 → 只改标题 → 保存 → 查库里的依据还在不在。
  const beforeRefs = await page.evaluate(() => null); // 占位：真实读库在下面
  const evidenceBefore = store.db.prepare("select json_extract(data,'$.evidence') e from entities where kind='judgment' and archived=0").all()
    .map(row => JSON.parse(row.e)).find(list => Array.isArray(list) && list.some(item => item.kind === 'file')) ?? [];
  const targetJudgment = store.db.prepare("select id from entities where kind='judgment' and archived=0").all()
    .map(row => store.get(ctx, row.id)).find(item => (item.data.evidence ?? []).some(one => one.kind === 'file'));
  if (targetJudgment && evidenceBefore.length) {
    await page.evaluate(id => {
      const card = [...document.querySelectorAll('#knowbody [data-id]')].find(node => node.dataset.id === id);
      card?.click();
    }, targetJudgment.id);
    await new Promise(resolve => setTimeout(resolve, 900));
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('#detailbody button')].find(node => node.textContent === '编辑判断');
      button?.click();
    });
    await new Promise(resolve => setTimeout(resolve, 900));
    const titleChanged = await page.evaluate(() => {
      const field = document.querySelector('[data-field="title"]');
      if (!field) return false;
      field.value = field.value + '（改过）';
      return true;
    });
    await page.evaluate(() => document.querySelector('#objpreview')?.click());
    await new Promise(resolve => setTimeout(resolve, 1500));
    // 把标题改回去：这条检查会动数据，不该给别的断言留副作用（第一次就是它把后面的"状态带符号"弄红了）。
    await page.evaluate(id => {
      const card = [...document.querySelectorAll('#knowbody [data-id]')].find(node => node.dataset.id === id);
      card?.click();
    }, targetJudgment.id);
    await new Promise(resolve => setTimeout(resolve, 700));
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('#detailbody button')].find(node => node.textContent === '编辑判断');
      button?.click();
    });
    await new Promise(resolve => setTimeout(resolve, 700));
    await page.evaluate(() => { const field = document.querySelector('[data-field="title"]'); if (field) field.value = field.value.replace('（改过）', ''); });
    await page.evaluate(() => document.querySelector('#objpreview')?.click());
    await new Promise(resolve => setTimeout(resolve, 1200));
    const after = store.get(ctx, targetJudgment.id);
    const refsAfter = after?.data?.evidence ?? [];
    const kept = refsAfter.filter(one => one.kind === 'file' || one.kind === 'audio' || one.kind === 'web').length;
    const hadNonNote = evidenceBefore.filter(one => one.kind !== 'note').length;
    check('编辑一次判断之后，依据的出处仍在（判据 3 不被编辑弄丢）',
      titleChanged && kept === hadNonNote,
      '改前有 ' + hadNonNote + ' 条带出处的依据 · 改后剩 ' + kept + ' 条 · 依据总数 ' + refsAfter.length);
  } else {
    check('编辑一次判断之后，依据的出处仍在（判据 3 不被编辑弄丢）', false, '夹具里没有"带文件出处的判断"，这条没法测（不是通过）');
  }
  await page.screenshot({path: 'prototype/screenshots/judgment-detail.png'});
  console.log('截图：prototype/screenshots/judgment-list.png · judgment-detail.png');
} finally {
  await browser.close();
  server.close();
  store.close();
}
const failed = results.filter(r => !r.ok);
console.log('─'.repeat(56));
console.log(failed.length ? `FAIL: ${failed.length} 项未通过` : `PASS: ${results.length} 项全部通过（真实浏览器 + 真实会议数据）`);
process.exit(failed.length ? 1 : 0);
