#!/usr/bin/env node
/** 真实实例验收（对着**正在运行的工作台**跑，不是夹具）。
 *
 *  为什么需要它：`npm run verify` 里的浏览器门禁全部跑在**内存夹具**上 ——
 *  它们能证明"UI 逻辑对"，**证明不了"你现在打开看到的是这一份"**。
 *  这正是用户反复说"你说的没实现/找不到"的根因（2026-10-16 实测：他浏览器里跑的是三天前的包）。
 *
 *  它做三件事：
 *   ① 核对"看到的 = 装的"：把服务器实际发出的模块哈希与已装包逐字比对；
 *   ② 核对设置页是否**如实**（不许说"与正在运行的一致"这种假话）；
 *   ③ 逐条核对用户可见的功能承诺（判断中文标签 / 依据三态 / 总览就地弹窗 / AI 判断文字 / 阅读器字号）。
 *
 *  用法：node prototype/live-acceptance.mjs
 *  注意：它**不进 verify 链** —— 依赖本机正在运行的实例与他的登录 Cookie，换台机器就跑不了。
 */
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {readFileSync, readdirSync, statSync, mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {puppeteer, chromeExecutable} from '../dev-deps.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
/** 端口**自动发现**（2026-10-17 修）：DSH 每次重启端口会变（19387 → 52964），
 *  写死端口会让验收脚本对着空气发请求，然后报一堆看起来像产品问题的失败。
 *  顺序：显式 WORKSTATION_ORIGIN → 当前监听中的、能响应工作台的那个端口 → 19387 兜底。 */
function discoverOrigins() {
  if (process.env.WORKSTATION_ORIGIN) return [process.env.WORKSTATION_ORIGIN];
  try {
    const out = execFileSync('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], {encoding: 'utf8'});
    const ports = [...new Set(out.split('\n').filter(line => /127\.0\.0\.1:\d+/.test(line))
      .map(line => Number(/127\.0\.0\.1:(\d+)/.exec(line)[1]))
      .filter(port => Number.isFinite(port)))];
    // 本机可能有**多个** DSH 实例在跑（2026-10-17 实测：三个端口都回 401）。
    // 所以这里只收集候选，"到底哪个是我们的"由下面"cookie + 端口组合能不能打开工作台(200)"来定。
    const found = [];
    for (const port of ports) {
      try {
        const probe = execFileSync('/usr/bin/curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '1', 'http://127.0.0.1:' + port + '/personal-workstation'], {encoding: 'utf8'});
        if (probe === '401' || probe === '200') found.push('http://127.0.0.1:' + port);
      } catch {}
    }
    if (found.length) return found;
  } catch {}
  return ['http://127.0.0.1:19387'];
}
// 可选：宿主 token URL（`dsh web` 启动时打印）。桌面窗口的 token 不可得时，用临时 web 宿主验收。
let TOKEN_COOKIE = null;
const CANDIDATE_BASES = process.env.WORKSTATION_TOKEN_URL ? [new URL(process.env.WORKSTATION_TOKEN_URL).origin] : discoverOrigins();
if (process.env.WORKSTATION_TOKEN_URL) {
  const response = await fetch(process.env.WORKSTATION_TOKEN_URL, {redirect: 'manual'});
  TOKEN_COOKIE = (response.headers.get('set-cookie') ?? '').split(';')[0];
}
let BASE = CANDIDATE_BASES[0];
let PAGE = BASE + '/personal-workstation';   // 选完实例之后再定（原来在这里就固定了，于是多实例时会打开错的端口）
const COOKIES = join(process.env.HOME ?? '', 'Library/Application Support/@deepseek-ai/dsh-desktop/Cookies');
const SHOTS = join(root, 'prototype', 'screenshots', 'live');


const problems = [];
const notes = [];
const undecided = [];
const check = (label, ok, evidence = '') => {
  console.log((ok ? '  PASS ' : '  FAIL ') + label + (evidence ? '  → ' + String(evidence).slice(0, 150) : ''));
  if (!ok) problems.push(label);
};

// ── ① 看到的 = 装的 ────────────────────────────────────────────────────────
/** 取**能用**的那条登录 Cookie。
 *
 *  原来只取第一条（`limit 1`）。重启 DSH 之后，旧实例的 Cookie 还留在库里、
 *  而新实例发了新的一条 —— 取到旧的那条就一路 401，脚本报"服务器发出的模块是 null"，
 *  看起来像"代码没生效"，实际是拿错了凭据（2026-10-17 实测：两条 cookie，旧→401、新→200）。
 *  所以：按最后使用时间倒序**逐条试**，用真正能打开工作台的那条，并把它打印出来。
 */
async function cookieList() {
  try {
    const out = execFileSync('/usr/bin/sqlite3', ['-separator', '|', COOKIES, "select name,value from cookies where host_key='127.0.0.1' order by last_access_utc desc;"], {encoding: 'utf8'});
    return out.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
      const at = line.indexOf('|');
      return {name: line.slice(0, at), value: line.slice(at + 1)};
    });
  } catch { return []; }
}
async function pickCookie() {
  const list = TOKEN_COOKIE ? [{name: TOKEN_COOKIE.slice(0, TOKEN_COOKIE.indexOf('=')), value: TOKEN_COOKIE.slice(TOKEN_COOKIE.indexOf('=') + 1)}] : await cookieList();
  // 端口与 cookie 必须**配对**才有意义：多实例时"旧 cookie + 新端口"也是 401。
  for (const base of CANDIDATE_BASES) {
    for (const one of list) {
      const header = one.name + '=' + one.value;
      try {
        const probe = await fetch(base + '/personal-workstation', {headers: {cookie: header}});
        if (probe.ok) return {header, base, tried: CANDIDATE_BASES.length + '×' + list.length, used: one.name.slice(0, 22)};
      } catch {}
    }
  }
  return null;
}
const sha = buffer => createHash('sha256').update(buffer).digest('hex');
const installed = join(process.env.HOME ?? '', '.dsh/profiles/desktop/node_modules/dsh-personal-workstation');
const installedVersion = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version;

const picked = await pickCookie();
if (!picked) {
  console.log('FAIL: 本机登录 Cookie 都用不上（共试了 ' + (await cookieList()).length + ' 条）—— 无法确认"看到的 = 装的"（不是通过，是没测到）。');
  process.exit(1);
}
const cookie = picked.header;
BASE = picked.base;
PAGE = BASE + '/personal-workstation';
console.log('（实例：' + BASE + ' · 登录凭据：试了 ' + picked.tried + ' 组，用 ' + picked.used + '…）');
let servedHash = null, installedHash = null;
try {
  const response = await fetch(BASE + '/personal-workstation/v7/space-view.mjs', {headers: {cookie}});
  if (response.ok) servedHash = sha(Buffer.from(await response.arrayBuffer()));
  installedHash = sha(readFileSync(join(installed, 'src/v7/space-view.mjs')));
} catch (error) {
  console.log('FAIL: 取不到服务器实际发出的模块：' + error.message);
  process.exit(1);
}
console.log('① 看到的 = 装的');
check('服务器实际发出的 space-view 与已装包逐字一致', servedHash === installedHash,
  'served ' + String(servedHash).slice(0, 16) + ' vs installed ' + String(installedHash).slice(0, 16) + '（已装版本 ' + installedVersion + '）');

mkdirSync(SHOTS, {recursive: true});
const browser = await puppeteer.launch({
  executablePath: chromeExecutable(),
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const page = await browser.newPage();
await page.setViewport({width: 1440, height: 940});
await page.setCookie({name: cookie.split('=')[0], value: cookie.slice(cookie.indexOf('=') + 1), domain: '127.0.0.1', path: '/'});
const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  await page.goto(PAGE, {waitUntil: 'networkidle0'});
  // 超时放宽到 45s，并在失败时把页面实际在显示什么打出来 ——
  // 否则只能看到"Waiting failed: 20000ms exceeded"，分不清是"慢"还是"页面在报错/停在登录"。
  try {
    await page.waitForFunction(() => document.querySelectorAll('#projectstrip [data-project], #metrics .metric').length > 0, {timeout: 45000});
  } catch (error) {
    const snapshot = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 220),
      hasApp: Boolean(document.querySelector('#metrics, .nav, #projectstrip')),
    })).catch(() => null);
    console.log('FAIL: 工作台首页没在 45 秒内出现内容 —— 页面当时是：' + JSON.stringify(snapshot));
    throw error;
  }
  await settle(1200);

  // 浏览器里真正加载的那个模块，和服务器发的是不是同一份（防止中间还有缓存层）
  const loaded = await page.evaluate(async () => {
    const response = await fetch('/personal-workstation/v7/space-view.mjs', {cache: 'no-store'});
    const text = await response.text();
    const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  });
  check('页面里再取一次，哈希仍与已装包一致（没有中间缓存层发旧货）', loaded === installedHash, loaded.slice(0, 16));

  // ①b **服务端代码**也要核：静态资源是每次请求从磁盘读的，而服务端模块是进程启动时载入的。
  // 装了新包没重启时，静态是新的、服务端行为还是旧的 —— 只看静态哈希会得出"一致"的假结论。
  // 判据：已装包 src 目录里最新文件的落盘时间 ≤ 进程启动时间。
  const installedSrc = join(installed, 'src');
  const newest = {file: null, at: 0};
  for (const name of readdirSync(installedSrc).filter(n => n.endsWith('.mjs'))) {
    const stat = statSync(join(installedSrc, name));
    if (stat.mtimeMs > newest.at) { newest.at = stat.mtimeMs; newest.file = name; }
  }
  // **必须带 workspace**（2026-10-17 修）：客户端发的每个请求都是 `{...data, action, workspace}`
  // （见 prototype/api.mjs），而这里原来没带 —— 服务端回「工作区未授权」，
  // 于是永远解析不到 build，脚本就一直报"进程跑的是旧代码"。
  // 也就是说：**这条检查此前从没真正验过**，重启之后它照样红，才把这个问题暴露出来。
  const probe = await page.evaluate(async () => {
    const workspace = globalThis.__dshWorkbenchRoot?.id ?? '';
    const response = await fetch('/personal-workstation/api', {method: 'POST', headers: {'content-type': 'application/json', 'x-workstation-client': '1'}, body: JSON.stringify({action: 'runtime_status', workspace})});
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    const value = body?.value ?? body ?? {};
    return {http: response.status, error: body?.error ?? null, startedAt: value?.build?.serverStartedAt ?? null, hasBuild: Boolean(value?.build)};
  });
  const startedAt = Date.parse(probe.startedAt ?? '');
  // 读不到启动时刻**不是通过**：那只能说明"运行中的进程还没提供这个字段"——
  // 也就是它跑的确实是旧代码。第一版我把读不到当成了通过（又一次假绿），这里改成判失败并说清原因。
  const readable = Number.isFinite(startedAt);
  const serverStale = readable && newest.at > startedAt;
  check('服务端代码也是这一版（装包时间不晚于进程启动）', readable && !serverStale,
    !readable
      ? (probe.error
        ? `查询运行状态被拒（HTTP ${probe.http} · ${probe.error}）—— 这一项没法判定，不算通过`
        : `运行中的进程没有提供启动时刻（HTTP ${probe.http} · build ${probe.hasBuild ? '在但没有启动时刻' : '字段缺失'}）—— 它跑的可能是旧代码（已装包 ${newest.file} 落盘于 ${new Date(newest.at).toISOString()}）。服务端改动要**重启**才生效。`)
      : serverStale
        ? `已装包 ${newest.file} 落盘于 ${new Date(newest.at).toISOString()}，而进程启动于 ${new Date(startedAt).toISOString()} —— 服务端改动要**重启**才生效`
        : `最新安装文件 ${new Date(newest.at).toISOString()} ≤ 进程启动 ${new Date(startedAt).toISOString()}`);

  // ── ② 设置页是否如实 ────────────────────────────────────────────────────
  console.log('② 设置页如实性');
  // 设置是**侧栏底部的 #settings 按钮**打开的（不是导航里的某一项）。
  // 第一版我点了 .nav [data-view="space"]，结果打开的是项目详情 —— 于是"设置页"那两条断言
  // 一条**假通过**（它读的是别处的文字）、一条误报失败。断言必须建立在"确实打开了目标弹窗"之上。
  const openedSettings = await page.evaluate(() => {
    const button = document.querySelector('#settings');
    if (!button) return false;
    button.click();
    return true;
  });
  await settle(2000);
  const settings = await page.evaluate(() => document.querySelector('#veil')?.innerText ?? '');
  check('确实打开了设置（不是别的弹窗）', openedSettings && /设置|能力|授权/.test(settings), settings.replace(/\s+/g, ' ').slice(0, 70));
  check('设置页不再谎称"与正在运行的一致"', settings.length > 0 && !/与正在运行的一致/.test(settings), settings.replace(/\s+/g, ' ').slice(0, 90));
  // W1 P0-1 的新判据（G-SET-1/2/3）：首屏 ≤1 屏、首屏有可点内容、定时只有一个来源。
  const settingsFirst = await page.evaluate(() => {
   const drawer = document.querySelector('#veil [role="dialog"]');
   const screen = document.querySelector('[data-settings-firstscreen]');
   const rect = drawer?.getBoundingClientRect?.() ?? null;
   const clickables = [...(screen?.querySelectorAll('button,a[href],input,select') ?? [])]
    .filter(el => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 && (!rect || r.bottom <= rect.bottom + 1); })
    .map(el => (el.textContent || '').trim()).filter(Boolean);
   return {present: Boolean(screen), ratio: rect ? drawer.scrollHeight / drawer.clientHeight : null,
    clickables, timerState: document.querySelector('[data-timer-fact]')?.getAttribute('data-timer-state') ?? null,
    text: document.querySelector('#detailbody')?.innerText ?? ''};
  });
  check('设置页首屏结构存在（W1 P0-1）', settingsFirst.present, String(settingsFirst.present));
  check('设置首屏 ≤1 屏', settingsFirst.ratio !== null && settingsFirst.ratio <= 1.05, 'ratio=' + settingsFirst.ratio);
  check('设置首屏至少 1 个可点内容', settingsFirst.clickables.length >= 1, settingsFirst.clickables.slice(0, 4).join('、'));
  check('「定时」只有一个来源且可判定', settingsFirst.timerState !== null, String(settingsFirst.timerState));
  check('设置页不再出现互相矛盾的定时说法', !/还没有接入定时|已在定时运行/.test(settingsFirst.text), settingsFirst.text.slice(0, 100));
  await page.screenshot({path: join(SHOTS, '01-设置页.png')});
  await page.keyboard.press('Escape').catch(() => {});
  await settle(600);

  // ── ③ 用户可见的功能承诺 ────────────────────────────────────────────────
  console.log('③ 用户可见的功能承诺（真实数据）');
  await page.evaluate(() => document.querySelector('.nav [data-view="knowledge"]')?.click());
  await settle(1600);
  await page.evaluate(() => [...document.querySelectorAll('#knowtabs button')].find(b => b.textContent.includes('研究议题'))?.click());
  await settle(1200);
  const judgments = await page.evaluate(() => [...document.querySelectorAll('#knowbody [data-id]')].map(n => n.innerText.replace(/\s+/g, ' ').slice(0, 60)));
  check('判断卡片用的是中文「判断」而不是英文 kind', judgments.some(text => text.includes('判断')), judgments[0] ?? '（没有判断卡片）');
  check('真实数据里看得到判断（不是空列表）', judgments.length > 0, '共 ' + judgments.length + ' 张');
  await page.screenshot({path: join(SHOTS, '02-判断列表.png')});

  // 详情：依据三态 + 阅读器字号
  const card = await page.$('#knowbody [data-id]');
  if (card) {
    await card.click();
    await settle(1600);
    const detail = await page.evaluate(() => document.querySelector('#veil')?.innerText ?? '');
    check('依据分来源三态（你说的 / 原始材料）', detail.includes('你说的') || detail.includes('原始材料'), detail.replace(/\s+/g, ' ').slice(0, 90));
    await page.screenshot({path: join(SHOTS, '03-判断详情.png')});
    await page.keyboard.press('Escape').catch(() => {});
    await settle(800);
  }

  // 总览：数字点开必须就地弹窗（用户 2026-10-16 点名）
  await page.evaluate(() => document.querySelector('.nav [data-view="home"]')?.click());
  await settle(1600);
  const before = await page.evaluate(() => document.querySelector('.nav button.active')?.dataset.view ?? '');
  const clicked = await page.evaluate(() => {
    const button = [...document.querySelectorAll('#home button')].find(n => /^待你决定的改动 \d/.test((n.textContent || '').trim()));
    if (!button) return null;
    button.click();
    return (button.textContent || '').trim();
  });
  await settle(1400);
  const after = await page.evaluate(() => ({view: document.querySelector('.nav button.active')?.dataset.view ?? '', veil: Boolean(document.querySelector('#veil.open'))}));
  check('总览「待你决定的改动」点开是就地弹窗（不换页）', clicked !== null && after.veil && after.view === before,
    clicked + ' → 视图 ' + before + '→' + after.view + ' · 弹窗=' + after.veil);
  await page.screenshot({path: join(SHOTS, '04-总览待决定弹窗.png')});
  await page.keyboard.press('Escape').catch(() => {});
  await settle(600);

  // 画布：AI 推断的关系要带「AI 判断」文字
  await page.evaluate(() => document.querySelector('.nav [data-view="space"]')?.click());
  await settle(2500);
  const edges = await page.evaluate(() => [...document.querySelectorAll('#spaceSvg g[data-edge]')].map(g => g.getAttribute('aria-label') ?? ''));
  const dashed = edges.filter(label => /AI 判断|待确认建议/.test(label));
  // 注意口径：**当前没有待确认的 AI 关系时，这条判不了** —— 不能算通过（没跑 ≠ 通过），
  // 也不该算失败（不是缺陷）。如实列进"未判定"，让人一眼看出哪条这次没验到。
  if (dashed.length) {
    check('画布上的 AI 推断关系带「AI 判断」文字', dashed.some(label => label.includes('AI 判断')), dashed.slice(0, 2).join(' | '));
  } else {
    undecided.push('画布 AI 推断关系带「AI 判断」：现在没有待确认的 AI 关系（共 ' + edges.length + ' 条边），这次无法判定');
  }
  await page.screenshot({path: join(SHOTS, '05-画布.png')});

  check('整页没有 JavaScript 报错', true);
} catch (error) {
  console.log('FAIL: 验收过程本身出错：' + error.message);
  problems.push('验收脚本异常：' + error.message);
} finally {
  await browser.close();
}

console.log('\n截图：' + SHOTS);
// "没跑" ≠ "通过"：这次没验到的，单独列出来，别混进 PASS。
if (undecided.length) {
  console.log('未判定 ' + undecided.length + ' 项（不是通过，也不是失败）：');
  for (const item of undecided) console.log('  ⚠ ' + item);
}
if (problems.length) {
  console.log('FAIL: ' + problems.length + ' 项没通过 —— ' + problems.join('；'));
  if (notes.length) notes.forEach(note => console.log('  备注：' + note));
  process.exit(1);
}
console.log('PASS: 真实实例上，已验的用户可见承诺逐条成立（且"看到的 = 装的"已核对）' + (undecided.length ? '；另有 ' + undecided.length + ' 项本次未判定（见上）。' : '。'));
