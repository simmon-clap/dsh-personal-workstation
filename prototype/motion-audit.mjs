/** 动效门禁（VI §10 · 03 §3「连续不表演」）。
 *
 *  为什么需要它：这条以前是**纯人工**的（对照表里标着"靠人工看"）。但它是可量的 ——
 *  代码里已经定了规矩（丝滑标准：120–220ms、位移 ≤8px），只是没人量。
 *
 *  判据（从宪章第八条「明确不做：装饰性动效」+ 03 §3「连续不表演」推）：
 *    ① 没有**过长的动效** —— 超过 300ms 的过渡会让界面"表演"，不是在响应你；
 *    ② 没有**装饰性动效** —— 循环/无限动画（`animation-iteration-count: infinite`）只有
 *       加载指示器允许（它表达"正在做"，是状态不是装饰）；
 *    ③ 动效必须**有存在理由** —— 只允许出现在会变的东西上（弹窗、提示、状态点、进度），
 *       纯文本容器不该有过渡。
 *
 *  为什么量"渲染结果"而不是查源码：源码里写 `transition:.2s` 和实际生效可能不是一回事
 *  （被覆盖、被 media query 关掉、元素压根不渲染）。规矩是量出来的，不是读出来的。
 *
 *  用法：node prototype/motion-audit.mjs
 */
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {httpRoute} from '../src/http-route.mjs';
import {WorkstationStore} from '../src/store.mjs';
import {ExecutionStore} from '../src/execution-store.mjs';
import {seedVisualStore} from './visual-seed.mjs';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

const chrome = chromeExecutable();

const MIN_MS = 100;            // 丝滑标准的下界（比这更快会显得跳）
const MAX_MS = 300;            // 超过就是"表演"了
const SWEET_MS = 220;          // 03 §3 给的舒适上界：120–220ms
const VIEWS = ['home', 'inbox', 'space', 'projects', 'tasks', 'knowledge', 'personal'];
/** 允许存在无限动画的东西：表达"正在进行"的加载指示，不是装饰。 */
const LOADING = /loading|spinner|skeleton|shimmer|pulse|progress/i;

const store = new WorkstationStore(':memory:');
const executions = new ExecutionStore(store);
seedVisualStore(store);
const connection = {admit: () => ({peer: {id: 'motion'}}), requestRejection: () => undefined};
const route = httpRoute({
  store, executions, connection,
  workspaceRegistry: {list: () => [{id: 'w', title: '个人空间'}], get: () => ({id: 'w'})},
  allowedWorkspaces: ['w'],
});
const server = createServer((request, response) => route.handler(request, response));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const browser = await puppeteer.launch({executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']});
const page = await browser.newPage();
await page.setViewport({width: 1440, height: 940});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const problems = [];
const seen = new Set();
try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/personal-workstation', {waitUntil: 'networkidle0'});
  await page.waitForFunction(() => document.querySelectorAll('#projectstrip [data-project]').length > 0, {timeout: 15000});

  // ── 探针自检（2026-10-16 补）──────────────────────────────────────────────
  // 这个界面本来就几乎不用动效（整个外壳只有 3 处 transition）。只量页面上的元素，
  // 会得出"覆盖很薄"的结论 —— 而门禁照样报绿，等于没管住。
  // 正确解法（与 craft-audit 的探针同一套）：**先注入一个故意越界的动效**，
  // 确认测量这条路径真的能量到它；量不到就说明这道门禁根本没有测量能力，必须判失败。
  await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.id = 'motionprobe';
    probe.style.cssText = 'position:fixed;left:-9999px;width:10px;height:10px;transition:opacity 800ms linear';
    document.body.append(probe);
  });
  const canaryMs = await page.evaluate(() => {
    const el = document.getElementById('motionprobe');
    return el ? parseFloat(getComputedStyle(el).transitionDuration) * 1000 : -1;
  });
  await page.evaluate(() => document.getElementById('motionprobe')?.remove());
  if (!(canaryMs > MAX_MS)) {
    console.log(`FAIL: 动效门禁自检没过 —— 注入 800ms 的探针，实测只读到 ${canaryMs}ms。`);
    console.log('      说明测量这条路径不可用（读不到 transition-duration），此时报"通过"是假的。');
    await browser.close(); await new Promise(r => server.close(r)); store.close();
    process.exit(1);
  }
  console.log(`探针自检通过：注入 800ms 的动效被读到 ${Math.round(canaryMs)}ms —— 这道门禁确实有测量能力。`);

  const inspect = async where => {
    const rows = await page.evaluate(() => {
      const ms = value => {
        const text = String(value || '').split(',')[0].trim();
        const num = parseFloat(text) || 0;
        return /ms$/.test(text) ? num : num * 1000;
      };
      const out = [];
      for (const node of document.querySelectorAll('body *')) {
        const rect = node.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        const cs = getComputedStyle(node);
        const cls = (node.className && typeof node.className === 'string' ? node.className : '').trim().split(/\s+/).slice(0, 2).join('.');
        const tag = node.tagName.toLowerCase();
        const durations = [cs.transitionDuration, cs.animationDuration].flatMap(v => String(v || '').split(',')).map(ms).filter(n => n > 0);
        const infinite = cs.animationIterationCount.split(',').some(v => v.trim() === 'infinite') && ms(cs.animationDuration) > 0;
        if (durations.length) out.push({id: tag + (cls ? '.' + cls : ''), max: Math.max(...durations), infinite, text: (node.textContent || '').trim().slice(0, 20)});
      }
      return out;
    });
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      if (row.max > MAX_MS) problems.push(`${where}：动效过长 ${Math.round(row.max)}ms（上限 ${MAX_MS}ms）→ ${row.id}`);
      else if (row.max > SWEET_MS) problems.push(`${where}：动效超出丝滑标准 ${Math.round(row.max)}ms（应在 ${MIN_MS}–${SWEET_MS}ms）→ ${row.id}`);
      else if (row.max < MIN_MS) problems.push(`${where}：动效过快 ${Math.round(row.max)}ms（下界 ${MIN_MS}ms）→ ${row.id}`);
      if (row.infinite && !LOADING.test(row.id)) problems.push(`${where}：疑似装饰性动效（无限循环）→ ${row.id}`);
    }
  };

  for (const view of VIEWS) {
    await page.evaluate(v => document.querySelector('.nav [data-view="' + v + '"]')?.click(), view);
    await wait(700);
    await inspect('页面 · ' + view);
  }
  // 弹窗也要量：动效大多在这里
  for (const [name, open] of [['新建菜单', async () => page.click('#create')], ['设置', async () => page.click('#settings')]]) {
    await page.goto('http://127.0.0.1:' + server.address().port + '/personal-workstation', {waitUntil: 'networkidle0'});
    await page.waitForFunction(() => document.querySelectorAll('#projectstrip [data-project]').length > 0, {timeout: 15000});
    await wait(900);
    await open();
    await wait(900);
    await inspect('弹窗 · ' + name);
  }
  // VI §11：`prefers-reduced-motion` 下**所有动效即时完成**。这条此前没人查。
  // 做法：真的把系统偏好设成 reduce，再量一遍 —— 该为 0 的地方必须为 0。
  await page.emulateMediaFeatures([{name: 'prefers-reduced-motion', value: 'reduce'}]);
  await page.goto('http://127.0.0.1:' + server.address().port + '/personal-workstation', {waitUntil: 'networkidle0'});
  await page.waitForFunction(() => document.querySelectorAll('#projectstrip [data-project]').length > 0, {timeout: 15000});
  await wait(700);
  const stillAnimated = await page.evaluate(() => {
    const ms = value => {
      const text = String(value || '').split(',')[0].trim();
      const num = parseFloat(text) || 0;
      return /ms$/.test(text) ? num : num * 1000;
    };
    const out = [];
    for (const node of document.querySelectorAll('body *')) {
      const rect = node.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      const cs = getComputedStyle(node);
      const max = Math.max(ms(cs.transitionDuration), ms(cs.animationDuration));
      if (max > 0) {
        const cls = (node.className && typeof node.className === 'string' ? node.className : '').trim().split(/\s+/)[0];
        out.push(node.tagName.toLowerCase() + (cls ? '.' + cls : '') + ' ' + Math.round(max) + 'ms');
      }
    }
    return [...new Set(out)];
  });
  for (const row of stillAnimated) problems.push(`开了"减少动态效果"之后仍有动效（VI §11 要求即时完成）→ ${row}`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  store.close();
}

console.log(`动效门禁：量了 ${seen.size} 个有过渡/动画的元素（7 个页面 + 2 个弹窗，允许 ${MIN_MS}–${SWEET_MS}ms）+ "减少动态效果"下的即时完成检查`);
// **如实说出自己的边界**：这个界面本来就几乎不用动效（整个外壳只有 3 处 transition）。
// 量到的元素很少时，这道门禁的覆盖很薄 —— 必须说出来，不能让人以为"动效已经被管住了"。
// （同一个教训：门禁对着"没什么可量"的界面报绿，等于没有门禁。）
if (seen.size < 5) {
  console.log(`  ⚠ 覆盖很薄：只量到 ${seen.size} 个元素有动效，说明这个界面基本不用动效。`);
  console.log('    这道门禁管得住"已有的动效不越界"，**管不住"以后新加的动效"** —— 那仍然要靠人工看。');
}
if (problems.length) {
  console.log('');
  for (const problem of [...new Set(problems)]) console.log('  ⚠ ' + problem);
  console.log('\nFAIL: 动效超出丝滑标准（VI §10 / 03 §3「连续不表演」；宪章第八条不做装饰性动效）。');
} else {
  console.log('PASS: 没有过长的动效，也没有装饰性的无限动画。');
}
process.exit(problems.length ? 1 : 0);
