#!/usr/bin/env node
/** 语义门禁 v1（17 号约束 §3）——对着**正在运行的真实实例 + 真实数据**跑，不是夹具。
 *
 *  它补的是 `npm run verify` 的盲区：机械门禁只证明「在标尺内」，证明不了「层级对/用户能用」。
 *  判据在 `semantic-checks.mjs`（纯函数，自带 canary 自检）；本脚本只负责量 DOM。
 *
 *  用法：
 *    node prototype/semantic-gates.mjs              # 桌面 + 手机；FAIL 时退出码 1
 *    node prototype/semantic-gates.mjs --json       # 打印 JSON 报告
 *    node prototype/semantic-gates.mjs --canary     # 先跑判据 canary（离线夹具 + 实时注入）
 *    node prototype/semantic-gates.mjs --no-shots   # 不截图（默认截图留证）
 *
 *  只读纪律：不点保存/同意/撤销/画布缩放；打开弹窗一律 Escape 关闭；
 *  唯一一次「输入」是编辑弹窗里改标题后按 Escape（不保存、不产生草稿），用于量「未保存保护」。
 */
import {mkdirSync, writeFileSync, readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {findLiveTarget, launchBrowser, openPage, gotoView, wait} from './live-target.mjs';
import {runChecks, canaryReport, cleanFixture, IM_HEALTH_PATTERNS} from './semantic-checks.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(here, 'screenshots', 'semantic-gates');
const REPORT = join(SHOTS, 'semantic-report.json');
const VIEWS = ['home', 'inbox', 'space', 'projects', 'tasks', 'knowledge', 'personal'];
const MOBILE_VIEWS = ['home', 'tasks', 'inbox', 'knowledge'];
const args = new Set(process.argv.slice(2));
const jsonOnly = args.has('--json');
const withCanary = args.has('--canary');

/* ────────────────────────── 页内测量 ────────────────────────── */

const measureView = () => {
  const vis = el => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
  };
  const txt = el => (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const cls = el => (typeof el.className === 'string' ? el.className : '').trim();
  const family = el => cls(el).split(/\s+/)[0] || el.tagName.toLowerCase();
  const active = document.querySelector('.view.active');
  const name = active?.id || 'unknown';
  const near = (el, list, tol = 0.5) => list.some(v => Math.abs(el - v) <= tol);
  const isSolidAccent = el => {
    const cs = getComputedStyle(el);
    const m = /rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(cs.backgroundColor);
    if (!m) return false;
    const [r, g, b] = [+m[1], +m[2], +m[3]];
    const a = m[4] === undefined ? 1 : +m[4];
    if (a < 0.8) return false;
    const lightText = /rgba?\(\s*(2[0-4]\d|25[0-5]),\s*(2[0-4]\d|25[0-5]),\s*(2[0-4]\d|25[0-5])/.test(cs.color);
    return b > 150 && b - r > 40 && lightText;
  };
  const interactive = 'button,a[href],[role="button"],input[type="submit"]';
  const scoped = sel => [...document.querySelectorAll(sel)].filter(el => vis(el) && !el.closest('#veil'));

  // 标题层级：只看当前视图里的 h1–h4
  const headings = [...(active?.querySelectorAll('h1,h2,h3,h4') ?? [])].filter(vis).map(el => ({
    tag: el.tagName, text: txt(el).slice(0, 40), size: getComputedStyle(el).fontSize,
    weight: getComputedStyle(el).fontWeight, class: cls(el).slice(0, 30)
  }));
  // 700 字重（全页可见文本，排除弹窗）
  const weightViolations = [...document.querySelectorAll('body *')].filter(el => vis(el) && !el.closest('#veil'))
    .filter(el => el.children.length === 0 && txt(el).length > 0)
    .filter(el => Number(getComputedStyle(el).fontWeight) >= 700)
    .map(el => ({tag: el.tagName, text: txt(el).slice(0, 30), weight: getComputedStyle(el).fontWeight}));

  const primaries = scoped(interactive).filter(isSolidAccent).map(el => ({tag: el.tagName, id: el.id, class: cls(el).slice(0, 30), text: txt(el).slice(0, 20), bg: getComputedStyle(el).backgroundColor}));
  const primaryClassMismatch = scoped(interactive).filter(el => /(^|\s)primary(\s|$)/.test(cls(el)) && !isSolidAccent(el))
    .map(el => ({tag: el.tagName, id: el.id, class: cls(el).slice(0, 30), text: txt(el).slice(0, 20), bg: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color}));

  const topbarNew = scoped('#create').length > 0;
  const inViewNew = [...(active?.querySelectorAll('button,a[href],[role="button"]') ?? [])].filter(vis)
    .filter(el => /^(新建|创建)/.test(txt(el))).map(el => ({text: txt(el).slice(0, 16), id: el.id}));

  // 空数据画成数据：进度环、满宽条
  const rings = [...document.querySelectorAll('svg.ring')].filter(vis).map(el => ({text: txt(el), class: cls(el)}));
  const meters = [...document.querySelectorAll('.meter')].filter(vis).map(el => {
    const values = [...el.querySelectorAll('b')].map(b => Number.parseInt(txt(b), 10)).filter(Number.isFinite);
    const track = el.querySelector('i');
    const trackRatio = track && el.getBoundingClientRect().width ? track.getBoundingClientRect().width / el.getBoundingClientRect().width : 0;
    return {values, total: values.reduce((s, v) => s + v, 0), trackRatio};
  });

  const chips = [...document.querySelectorAll('.chip,.tag,.tagline,.statusdot')].filter(vis).map(el => {
    const cs = getComputedStyle(el);
    return {family: family(el), class: cls(el).slice(0, 30), text: txt(el).slice(0, 16), size: cs.fontSize,
      height: Math.round(el.getBoundingClientRect().height), radius: cs.borderRadius, bw: cs.borderWidth, pad: cs.padding};
  });
  const inputs = [...document.querySelectorAll('input:not([type="hidden"]),select,textarea')].filter(vis).map(el => {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    // 「输入一种」比的是**视觉签名**：text/search/date 类型不同不算两套控件（W2-2）。
    return {sig: [el.tagName, Math.round(r.height), cs.borderRadius, cs.borderWidth, cs.backgroundColor].join('|'), tag: el.tagName, type: el.type || '', class: cls(el).slice(0, 24), height: Math.round(r.height), radius: cs.borderRadius};
  });
  const icons = [...document.querySelectorAll('svg.icon')].filter(vis).map(el => ({w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height, stroke: getComputedStyle(el).strokeWidth, class: cls(el).slice(0, 20)}));
  const emptyStates = [...document.querySelectorAll('[class*="empty"]')].filter(vis).map(el => {
    const hasImg = !!el.querySelector('img,svg.illustration,svg.illu');
    const hasButton = [...el.querySelectorAll('button,a[href],[role="button"]')].some(vis);
    const hasHeading = !!el.querySelector('h1,h2,h3,h4,strong');
    return {signature: (hasImg ? 'img+' : '') + (hasHeading ? 'title+' : '') + (hasButton ? 'button' : 'no-next'), class: cls(el).slice(0, 30), hasImg, hasButton, hasHeading, text: txt(el).slice(0, 24)};
  });
  // 只量**按钮组件**（`.btn` + 顶栏控制）：标签页/日历 chip/导航是别的控件，不能混进"按钮三档"。
  // 46 审计的「6 种高度」是更宽口径（含标签页 32、日历 chip 26、导航 42）；本门禁把控件分开量，
  // 宽口径的"同一控件多套长相"由 S2（类名与渲染不一致）与具名人工检查兜住（见 spec/48）。
  const buttons = [...new Set([...document.querySelectorAll('.btn,#create,#settings,#assistant')].filter(el => vis(el) && !el.closest('#veil')).map(el => Math.round(el.getBoundingClientRect().height) + '|' + cls(el).slice(0, 24)))].map(key => ({height: Number(key.split('|')[0]), class: key.split('|')[1]}));

  // 11px 当正文：一段连续文字 >30 字却只有 11px
  const body11 = [...(active?.querySelectorAll('*') ?? [])].filter(el => vis(el) && el.children.length === 0)
    .filter(el => getComputedStyle(el).fontSize === '11px' && txt(el).length > 30).length;

  // 解释性/实现性文案
  const BANNED = [
    [/最近加载[^。]{0,12}条?/, '实现说明：分页条数'],
    [/主观[“"']?健康分/, '设计争论：健康分'],
    [/不同维度/, '设计争论：不同维度'],
    [/设计基线/, '设计/版本说明'],
    [/业务步骤与执行状态分别记录/, '实现说明：业务步骤 vs 执行状态'],
    [/这一页只显示真实状态/, '设置页自我解释'],
    [/预览交互.*不会调用模型/, '实现说明：预览交互']
  ];
  const scopeText = (active?.innerText ?? '') + '\n' + (document.querySelector('#subtitle')?.textContent ?? '');
  const wording = [];
  for (const [re, phrase] of BANNED) {
    const m = re.exec(scopeText);
    if (m) wording.push({phrase, quote: scopeText.slice(Math.max(0, m.index - 20), m.index + 40).replace(/\s+/g, ' ')});
  }

  const pageTitle = document.querySelector('#title');
  const subtitle = document.querySelector('#subtitle')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  return {
    view: name,
    subtitle,
    pageTitle: pageTitle ? {tag: pageTitle.tagName, text: txt(pageTitle), size: getComputedStyle(pageTitle).fontSize, weight: getComputedStyle(pageTitle).fontWeight} : null,
    headings, weightViolations, primaries, primaryClassMismatch,
    newEntrances: {topbar: topbarNew, inView: inViewNew, duplicate: topbarNew && inViewNew.length > 0},
    rings, meters, chips, inputs, icons, emptyStates, buttons,
    body11,
    filterText: (() => { const el = [...document.querySelectorAll('body *')].find(n => /筛选\s*·\s*\d+/.test(n.textContent ?? '') && n.children.length === 0); return el ? el.textContent.trim() : null; })(),
    wording,
    overflow: document.documentElement.scrollWidth - window.innerWidth
  };
};

const measureSettings = () => {
  const veil = document.querySelector('#veil');
  if (!veil?.classList.contains('open')) return {opened: false};
  const dialog = veil.querySelector('[role="dialog"]');
  const drawer = veil.querySelector('.drawer') ?? dialog;
  const drect = dialog.getBoundingClientRect();
  const rrect = drawer.getBoundingClientRect();
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
  const text = (drawer.innerText ?? '').replace(/\s+/g, ' ');
  const clickables = [...drawer.querySelectorAll('button,a[href],input,select,textarea,[role="button"]')].filter(vis).map(el => ({
    id: el.id, cls: (typeof el.className === 'string' ? el.className : '').slice(0, 30),
    text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 20),
    insideFooter: !!el.closest('.modalactions'),
    top: Math.round(el.getBoundingClientRect().top - rrect.top)
  }));
  const firstScreenContent = clickables.filter(c => !c.insideFooter && c.top >= 0 && c.top < rrect.height
    && !/(^|\s)(back|close)(\s|$)/.test(c.cls)).map(c => c.text);
  const footerActions = clickables.filter(c => c.insideFooter).map(c => c.text);
  const sentences = text.split(/[。；\n]+/).map(s => s.trim()).filter(Boolean);
  const NEG = ['未接入', '还没有接入', '没有接入', '未配置', '未实现'];
  const POS = ['已在定时运行', '已接入', '已配置', '已实现', '正在运行', '已在运行'];
  const negs = sentences.filter(s => /定时|提醒|心跳/.test(s) && NEG.some(n => s.includes(n)));
  const poss = sentences.filter(s => /定时|提醒|心跳/.test(s) && POS.some(p => s.includes(p)));
  return {
    opened: true,
    dialog: {w: Math.round(drect.width), h: Math.round(drect.height), left: Math.round(drect.left), top: Math.round(drect.top), viewport: {w: innerWidth, h: innerHeight}},
    drawer: {sh: drawer.scrollHeight, ch: drawer.clientHeight, paddingBottom: Number.parseFloat(getComputedStyle(drawer).paddingBottom) || 0, overflowY: getComputedStyle(drawer).overflowY},
    firstScreenContent, footerActions,
    sections: [...drawer.querySelectorAll('h2')].map(h => ({text: h.textContent.trim(), top: Math.round(h.getBoundingClientRect().top - rrect.top)})),
    contradictions: {negs, poss, pairs: negs.length * poss.length},
    text: text.slice(0, 6000),
    actions: [...veil.querySelectorAll('.modalactions button')].map(b => ({text: b.textContent.trim().slice(0, 16), id: b.id, cls: (typeof b.className === 'string' ? b.className : '').slice(0, 24)}))
  };
};

const measureDialogState = () => {
  const veil = document.querySelector('#veil');
  if (!veil?.classList.contains('open')) return {open: false};
  const dialog = veil.querySelector('[role="dialog"]');
  const r = dialog.getBoundingClientRect();
  const free = [...document.body.children].filter(el => el !== veil && !['SCRIPT', 'STYLE', 'LINK', 'TEMPLATE'].includes(el.tagName)).filter(el => !el.inert).map(el => el.tagName + '#' + (el.id || ''));
  return {
    open: true,
    rect: {left: r.left, top: r.top, width: r.width, height: r.height},
    offset: {dx: (r.left + r.width / 2) - innerWidth / 2, dy: (r.top + r.height / 2) - innerHeight / 2},
    backgroundFree: free,
    focusInDialog: dialog.contains(document.activeElement),
    activeId: document.activeElement?.id || document.activeElement?.tagName
  };
};

const measureEditor = () => {
  const veil = document.querySelector('#veil');
  if (!veil?.classList.contains('open')) return {opened: false};
  const dialog = veil.querySelector('[role="dialog"]');
  const save = dialog.querySelector('#objpreview');
  const dangerButtons = [...dialog.querySelectorAll('.modalactions button')].filter(b => /删除|归档|清空/.test(b.textContent));
  const actions = [...dialog.querySelectorAll('.modalactions button')].map(b => ({id: b.id, text: b.textContent.trim(), cls: (typeof b.className === 'string' ? b.className : '').slice(0, 20), rect: b.getBoundingClientRect().toJSON()}));
  const gaps = save ? dangerButtons.map(b => Math.round(b.getBoundingClientRect().left - save.getBoundingClientRect().right)) : [];
  return {
    opened: true,
    actions,
    dangerGaps: gaps,
    dangerGap: gaps.length ? Math.min(...gaps) : null,
    titleField: !!dialog.querySelector('[data-field="title"]')
  };
};

const measureCanvas = () => {
  const svg = document.querySelector('#spaceSvg');
  if (!svg) return {opened: false};
  const world = document.querySelector('#spaceworld');
  const transform = world?.getAttribute('transform') ?? '';
  const m = /scale\(([\d.]+)\)/.exec(transform);
  const scale = m ? Number(m[1]) : 1;
  const texts = [...svg.querySelectorAll('text')].map(t => {
    const ctm = t.getScreenCTM();
    const s = ctm ? Math.abs(ctm.a) : scale;
    const fs = Number.parseFloat(getComputedStyle(t).fontSize) || 0;
    return {text: (t.textContent || '').slice(0, 30), size: fs, scale: Number(s.toFixed(3)), effective: Number((fs * s).toFixed(2))};
  });
  return {opened: true, zoom: scale, label: document.querySelector('#zoomlabel')?.textContent ?? '', transform, texts, status: (document.querySelector('#graphstatus')?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 200)};
};

const measureMobileView = () => {
  const active = document.querySelector('.view.active');
  const nav = document.querySelector('.nav');
  const navItems = [...document.querySelectorAll('.nav [data-view]')].map(el => Math.round(el.getBoundingClientRect().top));
  const navRows = new Set(navItems).size;
  const navH = nav ? Math.round(nav.getBoundingClientRect().height) : 0;
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(el).display !== 'none'; };
  const actionable = [...(active?.querySelectorAll('button,[role="button"],a[href],[data-task],[data-project],[data-id],[data-calevent]') ?? [])]
    .filter(vis).filter(el => { const r = el.getBoundingClientRect(); return r.top >= navH && r.top < innerHeight && r.bottom > navH; }).length;
  const isTasks = (active?.id || '') === 'tasks';
  const cards = isTasks ? [...document.querySelectorAll('#tasksbody [data-task]')].filter(vis) : [];
  const visibleTasks = isTasks ? cards.filter(el => { const r = el.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; }).length : null;
  const columns = isTasks ? [...document.querySelectorAll('#tasksbody .column')].map(el => ({head: el.innerText.split('\n')[0], count: el.querySelectorAll('[data-task]').length})) : [];
  const metrics = isTasks ? document.querySelector('#taskmetrics') : null;
  return {
    view: active?.id || 'unknown',
    navRows, navH,
    actionableFirstScreen: actionable,
    visibleTasks,
    firstTaskTop: isTasks ? Math.round(cards[0]?.getBoundingClientRect().top ?? -1) : null,
    columns,
    metricsH: Math.round(metrics?.getBoundingClientRect().height ?? 0),
    metricsText: (metrics?.innerText ?? '').replace(/\s+/g, ' '),
    metricsShowZero: /(^|\s)0(\s|$)/.test((metrics?.innerText ?? '').replace(/\s+/g, ' ')),
    overflow: document.documentElement.scrollWidth - innerWidth,
    text: (active?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 400)
  };
};

const measureMobileDetail = () => {
  const veil = document.querySelector('#veil');
  if (!veil?.classList.contains('open')) return {opened: false};
  const drawer = veil.querySelector('.drawer') ?? veil.querySelector('[role="dialog"]');
  const footer = veil.querySelector('.modalactions');
  const frect = footer?.getBoundingClientRect();
  const labels = ['负责人', '业务状态', '截止', '执行端'];
  const rowEls = [];
  for (const el of drawer.querySelectorAll('*')) {
    const t = (el.textContent ?? '').trim();
    if (!labels.includes(t) || el.children.length > 0) continue;
    const box = el.parentElement?.getBoundingClientRect();
    if (box) rowEls.push({text: t, top: Math.round(box.top), bottom: Math.round(box.bottom)});
  }
  const rows = rowEls;
  const overlaps = frect ? rows.filter(r => r.bottom > frect.top + 1 && r.top < frect.bottom).map(r => r.text) : [];
  return {
    opened: true,
    footerH: frect ? Math.round(frect.height) : 0,
    footerTop: frect ? Math.round(frect.top) : 0,
    paddingBottom: Number.parseFloat(getComputedStyle(drawer).paddingBottom) || 0,
    rows, overlaps,
    drawer: {sh: drawer.scrollHeight, ch: drawer.clientHeight}
  };
};
/** 打开详情后**先不滚**：量首屏能看到几个决定字段（46 审计的投诉点是首屏）。 */
const measureMobileDetailFirstScreen = () => {
  const veil = document.querySelector('#veil');
  if (!veil?.classList.contains('open')) return {firstScreenVisible: null};
  const drawer = veil.querySelector('.drawer') ?? veil.querySelector('[role="dialog"]');
  const footer = veil.querySelector('.modalactions');
  const frect = footer?.getBoundingClientRect();
  const labels = ['负责人', '业务状态', '截止', '执行端'];
  let visible = 0;
  for (const el of drawer.querySelectorAll('*')) {
    const t = (el.textContent ?? '').trim();
    if (!labels.includes(t) || el.children.length > 0) continue;
    const box = el.parentElement?.getBoundingClientRect();
    if (!box) continue;
    const inViewport = box.top >= 0 && box.bottom <= innerHeight;
    const underFooter = frect && box.bottom > frect.top;
    if (inViewport && !underFooter) visible += 1;
  }
  return {firstScreenVisible: visible};
};

/* ────────────────────────── 驱动 ────────────────────────── */

const sha = buffer => createHash('sha256').update(buffer).digest('hex');

async function collect(target, browser) {
  const data = {views: {}, collectedAt: new Date().toISOString(), instance: target.base};
  const page = await openPage(browser, target, {width: 1440, height: 940});
  mkdirSync(SHOTS, {recursive: true});

  for (const view of VIEWS) {
    await gotoView(page, view);
    data.views[view] = await page.evaluate(measureView);
    if (!jsonOnly) await page.screenshot({path: join(SHOTS, 'desktop-' + view + '.png')});
  }
  data.subtitleWording = await page.evaluate(() => {
    const text = document.querySelector('#subtitle')?.textContent ?? '';
    return /总览提示|当前页面提示/.test(text) ? [{phrase: '占位副标题（全站同一句）', quote: text}] : [];
  });
  data.pageTitle = data.views.home.pageTitle;

  // ── 设置弹窗：S3 度量 + S7 四条（居中/Escape/焦点恢复/背景不可操作）──
  await gotoView(page, 'home', 600);
  await page.click('#settings');
  await wait(1800);
  data.settings = await page.evaluate(measureSettings);
  const openState = await page.evaluate(measureDialogState);
  if (!jsonOnly) await page.screenshot({path: join(SHOTS, 'desktop-settings.png')});
  // 「首屏内容动作」：等异步区（心跳/授权）渲染完再量一次，避免把"正在读取…"的阶段当成最终状态
  await wait(1600);
  const settingsLate = await page.evaluate(measureSettings);
  if (settingsLate.opened) data.settings = settingsLate;
  // IM 四层在「接上了什么 → IM 助理 · 飞书」折叠里：展开后才读它的真实文字（S10），
  // 但不能在量首屏比例时展开——所以先量完 S3，再单独展开读一次。
  const hadIm = await page.evaluate(() => { const d = document.querySelector('[data-settings-im]'); if (!d) return false; d.open = true; return true; });
  if (hadIm) {
    await wait(500);
    data.settings.imText = await page.evaluate(() => document.querySelector('[data-settings-im]')?.innerText.replace(/\s+/g, ' ') ?? '');
    await page.evaluate(() => { const d = document.querySelector('[data-settings-im]'); if (d) d.open = false; });
  }
  await page.keyboard.press('Escape');
  await wait(500);
  const closedState = await page.evaluate(() => ({open: document.querySelector('#veil')?.classList.contains('open'), activeId: document.activeElement?.id || document.activeElement?.tagName}));
  data.settings.rules = {
    centered: Math.abs(openState.offset.dx) <= 2 && Math.abs(openState.offset.dy) <= 2,
    centeredOffset: openState.offset,
    escapeCloses: !closedState.open,
    focusRestored: closedState.activeId === 'settings',
    activeAfterClose: closedState.activeId,
    backgroundInert: openState.backgroundFree.length === 0,
    backgroundFree: openState.backgroundFree.slice(0, 5)
  };

  // ── 编辑弹窗：S7 未保存保护 + 危险按钮分离 ──
  await gotoView(page, 'projects');
  if (await page.$('#projectsbody [data-project]')) {
    await page.click('#projectsbody [data-project]');
    await wait(1400);
    if (await page.$('#newprojectedit')) {
      await page.click('#newprojectedit');
      await wait(1400);
      data.editor = await page.evaluate(measureEditor);
      // 未保存保护：改标题 → Escape → 会不会无确认直接关？
      await page.evaluate(() => {
        const field = document.querySelector('#detailbody [data-field="title"]');
        if (field) { field.value = field.value + '（语义门禁 canary）'; field.dispatchEvent(new Event('input', {bubbles: true})); }
      });
      await wait(300);
      await page.keyboard.press('Escape');
      await wait(500);
      const stillOpen = await page.evaluate(() => document.querySelector('#veil')?.classList.contains('open') === true);
      data.editor.unsavedProtected = stillOpen;
      if (stillOpen) { await page.keyboard.press('Escape'); await wait(300); }
      if (!jsonOnly) await page.screenshot({path: join(SHOTS, 'desktop-editor.png')});
    }
  }
  // 未保存实验不写数据：重载页面丢弃 DOM 改动
  await page.goto(target.pageUrl, {waitUntil: 'networkidle0'});
  await page.waitForFunction(() => document.querySelectorAll('.nav [data-view]').length >= 7, {timeout: 20000});
  await wait(1200);

  // ── 画布 ──
  await gotoView(page, 'space', 1600);
  data.canvas = await page.evaluate(measureCanvas);
  if (!jsonOnly) await page.screenshot({path: join(SHOTS, 'desktop-canvas.png')});
  // S14：默认进画布看到的结构态（分类列/未分类未归属/三重编码/缩放/项目>任务）
  data.canvasStructure = await measureStructureCanvas(page, wait);
  if (!jsonOnly) await page.screenshot({path: join(SHOTS, 'desktop-canvas-structure.png')});
  // S15：四表面组件签名（详情弹窗宽度/居中、空态结构、卡片密度、筛选控件数量）
  data.surfaces = await measureSurfaces(page, {gotoView, wait});
  await page.close();

  // ── 移动端 390 ──
  const mobile = await openPage(browser, target, {width: 390, height: 844, mobile: true});
  data.mobile = {views: {}, vh: 844};
  for (const view of MOBILE_VIEWS) {
    await gotoView(mobile, view, 1200);
    data.mobile.views[view] = await mobile.evaluate(measureMobileView);
    if (!jsonOnly) await mobile.screenshot({path: join(SHOTS, 'mobile-' + view + '.png')});
  }
  data.mobile.navRows = data.mobile.views.home.navRows;
  data.mobile.navH = data.mobile.views.home.navH;
  // 任务详情：滚到底量底栏是否盖住决定字段
  await gotoView(mobile, 'tasks', 1200);
  if (await mobile.$('#tasksbody [data-task]')) {
    await mobile.click('#tasksbody [data-task]');
    await wait(1600);
    const firstScreen = await mobile.evaluate(measureMobileDetailFirstScreen);
    await mobile.evaluate(() => { const d = document.querySelector('#veil .drawer'); if (d) d.scrollTop = d.scrollHeight; });
    await wait(600);
    data.mobile.detail = {...(await mobile.evaluate(measureMobileDetail)), ...firstScreen};
    const hidden = data.mobile.detail.rows.filter(r => data.mobile.detail.overlaps?.includes(r.text)).map(r => r.text);
    data.mobile.detail.hiddenAtBottom = [...new Set(hidden)];
    if (!jsonOnly) await mobile.screenshot({path: join(SHOTS, 'mobile-task-detail.png')});
    await mobile.keyboard.press('Escape');
  }
  await mobile.close();
  return data;
}

/** S14 测量：默认进画布（结构态）看到的分类列、未分类/未归属、三重编码、缩放与层级尺寸。
 *  只点「机构→项目」做原地展开（视图层，不写业务数据），量完 Esc 收起。 */
async function measureStructureCanvas(page, wait) {
  const read = () => page.evaluate(() => {
    const svg = document.querySelector('#spaceSvg');
    if (!svg) return {opened: false};
    const world = svg.querySelector('#spaceworld');
    const match = /scale\(([\d.]+)\)/.exec(world?.getAttribute('transform') || '');
    const zoom = match ? Number(match[1]) : null;
    const effective = [...svg.querySelectorAll('text')].map(node => {
      const size = Number.parseFloat(getComputedStyle(node).fontSize) || 0;
      const ctm = node.getScreenCTM?.();
      return size * (ctm?.a || 1);
    }).filter(value => value > 0);
    const buckets = [...svg.querySelectorAll('[data-bucket]')].map(node => {
      const key = node.dataset.bucket;
      return {
        key,
        label: (node.textContent || '').split('·')[0].trim(),
        kind: key === 'unclassified' ? 'unclassified' : key === 'unassigned' ? 'unassigned' : 'role',
        count: Number(/(\d+)/.exec(node.textContent || '')?.[1] ?? 0),
        hasShape: Boolean(node.querySelector('.roleshape'))
      };
    });
    const statusText = document.querySelector('#graphstatus')?.textContent ?? '';
    return {
      opened: true,
      mode: svg.dataset.canvasMode ?? null,
      zoom,
      minTextEffective: effective.length ? Math.min(...effective) : null,
      buckets,
      mainKinds: [...new Set([...svg.querySelectorAll('[data-node]')].map(node => node.dataset.kind))],
      unclassifiedCount: Number(/未分类 (\d+)/.exec(statusText)?.[1] ?? 0),
      unassignedCount: Number(/未归属项目 (\d+)/.exec(statusText)?.[1] ?? 0)
    };
  });
  const base = await read();
  let projectArea = null, taskArea = null;
  try {
    const org = await page.$('#spaceSvg [data-node][data-kind="organization"]');
    if (org) {
      await org.click();
      await wait(700);
      const project = await page.$('#spaceSvg [data-branch-child][data-kind="project"]');
      if (project) {
        const projectBox = await project.boundingBox();
        projectArea = projectBox ? projectBox.width * projectBox.height : null;
        await project.click();
        await wait(700);
        const task = await page.$('#spaceSvg [data-branch-child][data-kind="task"]');
        if (task) {
          const taskBox = await task.boundingBox();
          taskArea = taskBox ? taskBox.width * taskBox.height : null;
        }
      }
      await page.keyboard.press('Escape');
      await wait(300);
      await page.keyboard.press('Escape');
      await wait(300);
    }
  } catch { /* 量不到尺寸不冒充：projectArea/taskArea 保持 null，判据跳过该项 */ }
  return {...base, projectArea, taskArea};
}

/** S15 测量：四个表面打开详情量弹窗宽度/居中；收集空态结构签名、卡片密度、每页筛选控件数。 */
async function measureSurfaces(page, {gotoView, wait}) {
  const dialogs = [];
  const readDialog = async surface => {
    await wait(500);
    const box = await page.evaluate(() => {
      const veil = document.querySelector('#veil');
      if (!veil?.classList.contains('open')) return null;
      const dialog = veil.querySelector('[role="dialog"]') ?? veil.querySelector('.drawer');
      if (!dialog) return null;
      const rect = dialog.getBoundingClientRect();
      return {width: rect.width, centered: Math.abs(rect.left + rect.width / 2 - window.innerWidth / 2) <= 2};
    });
    if (box) dialogs.push({surface, ...box});
    await page.keyboard.press('Escape');
    await wait(400);
  };
  try {
    await gotoView(page, 'projects', 900);
    if (await page.$('#projectsbody [data-project]')) await page.click('#projectsbody [data-project]');
    await readDialog('projects');
    await gotoView(page, 'tasks', 900);
    if (await page.$('#tasksbody [data-task]')) await page.click('#tasksbody [data-task]');
    await readDialog('tasks');
    await gotoView(page, 'inbox', 900);
    if (await page.$('#inboxbody [data-batch], [data-batch]')) await page.click('#inboxbody [data-batch], [data-batch]');
    await readDialog('inbox');
  } catch { /* 某个表面打不开就少一条记录，判据会标「没有量到」而不是假绿 */ }
  const emptyStates = await page.evaluate(() => [...document.querySelectorAll('.v7-empty')].map(node => ({
    signature: [...node.children].map(child => child.tagName.toLowerCase()).join('+'),
    surface: node.closest('.view')?.id ?? ''
  })));
  const cardDensities = await page.evaluate(() => [...new Set([...document.querySelectorAll('[data-density]')].map(node => node.dataset.density))]);
  const filterToggles = await page.evaluate(() => {
    const out = {};
    for (const view of document.querySelectorAll('.view')) out[view.id || 'unknown'] = view.querySelectorAll('.filtertoggle').length;
    return out;
  });
  return {measured: true, dialogs, emptyStates, cardDensities, filterToggles};
}

/** 实时注入 canary：证明「测量路径」真的把 DOM 变化量进来了（判据逻辑的 canary 在 semantic-checks 里）。 */
async function liveCanary(target, browser) {
  const rows = [];
  const page = await openPage(browser, target, {width: 1440, height: 940});
  const reload = async () => {
    await page.goto(target.pageUrl, {waitUntil: 'networkidle0'});
    await page.waitForFunction(() => document.querySelectorAll('.nav [data-view]').length >= 7, {timeout: 20000});
    await wait(1300);
  };

  // 视图：标题/主色/空环/组件/文案
  await gotoView(page, 'home');
  const before = await page.evaluate(measureView);
  await page.evaluate(() => {
    const active = document.querySelector('.view.active');
    const bad = document.createElement('div');
    bad.id = 'canary';
    bad.innerHTML = '<h2 style="font-size:15px;font-weight:700">canary 标题</h2>'
      + '<button style="background:rgb(49,94,208);color:#fff">canary 主色</button>'
      + '<span class="tag">canary 标签</span>'
      + '<svg class="ring" width="40" height="40"><text>—</text></svg>'
      + '<svg class="icon" style="width:17px;height:17px;stroke-width:1.65"></svg>'
      + '<p>来源与项目筛选只作用于本页最近加载的 50 条</p>';
    active.append(bad);
  });
  await wait(300);
  const after = await page.evaluate(measureView);
  rows.push({id: 'live-S1', what: '注入 h2 15px/700 + 700 字重', caught: after.headings.some(h => h.weight >= 700) && after.weightViolations.length > before.weightViolations.length});
  rows.push({id: 'live-S2', what: '注入第二个主色按钮', caught: after.primaries.length > before.primaries.length});
  rows.push({id: 'live-S4', what: '注入空数据进度环', caught: after.rings.length > before.rings.length});
  rows.push({id: 'live-S6', what: '注入 17px 图标 / 第二套标签', caught: after.icons.some(i => Math.round(i.w) === 17) && new Set(after.chips.map(c => c.family)).size > new Set(before.chips.map(c => c.family)).size});
  rows.push({id: 'live-S12', what: '注入解释性文案', caught: after.wording.length > before.wording.length});
  await reload();

  // 设置：矛盾事实 / 内容区可点 / 四层健康（反向）
  await page.click('#settings');
  await wait(2200);
  const sBefore = await page.evaluate(measureSettings);
  await page.evaluate(() => {
    // 设置弹窗外壳既可能是 .drawer 也可能是 [role="dialog"]（W1 重排后要按角色找，别按类名）。
    const drawer = document.querySelector('#veil .drawer') ?? document.querySelector('#veil [role="dialog"]');
    if (!drawer) return;
    const block = document.createElement('div');
    // 注意：矛盾对是「否定句 × 肯定句」的乘积；真实数据修好之后可能一句否定都没有，
    // 所以 canary 必须同时注入一否一正，否则注入不会让判据变红（那是 canary 失效，不是界面合格）。
    block.innerHTML = '<div style="height:600px"></div><p>定时 还没有接入</p><p>定时与提醒 已配置好了</p>'
      + '<p>插件已加载 · 渠道已连接 · 会话目录已指向工作区 · 发送代码已实现</p>';
    drawer.prepend(block);
    const btn = document.createElement('button');
    btn.textContent = 'canary 首屏动作';
    drawer.prepend(btn);
  });
  await wait(300);
  const sAfter = await page.evaluate(measureSettings);
  const s3ratio = [sBefore.drawer.sh / sBefore.drawer.ch, sAfter.drawer.sh / sAfter.drawer.ch];
  const s3pairs = [sBefore.contradictions.pairs, sAfter.contradictions.pairs];
  const s3first = [sBefore.firstScreenContent, sAfter.firstScreenContent];
  if (process.env.DEBUG_S3) console.log('S3 debug', JSON.stringify({s3ratio, s3pairs, s3first, scroll: sAfter.drawer, sBeforeOpened: sBefore.opened}));
  // 注入 600px 会把原有首屏动作挤出首屏，所以看"注入的那个动作是否出现在首屏"，而不是数总数。
  rows.push({id: 'live-S3', what: '注入 600px 内容 + 定时矛盾 + 首屏内容动作', caught: s3ratio[1] > s3ratio[0] && s3pairs[1] > s3pairs[0] && s3first[1].includes('canary 首屏动作')});
  const healthAfter = healthOf(sAfter.text);
  rows.push({id: 'live-S10', what: '反向注入四层健康文字', caught: healthOf(sBefore.text).missing.length > healthAfter.missing.length});
  await page.keyboard.press('Escape');
  await wait(400);
  await reload();

  // 编辑弹窗：危险按钮相邻
  await gotoView(page, 'projects');
  if (await page.$('#projectsbody [data-project]')) {
    await page.click('#projectsbody [data-project]');
    await wait(1300);
    if (await page.$('#newprojectedit')) {
      await page.click('#newprojectedit');
      await wait(1300);
      const eBefore = await page.evaluate(measureEditor);
      await page.evaluate(() => {
        const actions = document.querySelector('#veil .modalactions');
        if (!actions) return;
        const danger = document.createElement('button');
        danger.className = 'btn';
        danger.textContent = 'canary 删除…';
        actions.append(danger);
      });
      await wait(200);
      const eAfter = await page.evaluate(measureEditor);
      rows.push({id: 'live-S7', what: '注入相邻的危险按钮', caught: eAfter.actions.length > eBefore.actions.length});
      await page.keyboard.press('Escape');
    }
  }
  await reload();

  // 画布：缩放响应
  await gotoView(page, 'space', 1600);
  const cBefore = await page.evaluate(measureCanvas);
  await page.evaluate(() => { const w = document.querySelector('#spaceworld'); if (w) w.setAttribute('transform', 'translate(84 208) scale(0.2)'); });
  await wait(300);
  const cAfter = await page.evaluate(measureCanvas);
  rows.push({id: 'live-S5', what: '把画布缩放到 20%（测量应响应）', caught: cAfter.zoom < cBefore.zoom});
  await reload();

  // 移动端：导航两行
  await page.setViewport({width: 390, height: 844, isMobile: true, hasTouch: true});
  await gotoView(page, 'home', 1400);
  const mBefore = await page.evaluate(measureMobileView);
  await page.evaluate(() => {
    const nav = document.querySelector('.nav');
    const item = nav?.querySelector('[data-view]');
    if (item) { const clone = item.cloneNode(true); clone.style.marginTop = '200px'; nav.append(clone); }
  });
  await wait(300);
  const mAfter = await page.evaluate(measureMobileView);
  rows.push({id: 'live-S8', what: '注入第二行导航', caught: mAfter.navRows > mBefore.navRows});

  await page.close();
  return rows;
}

function healthOf(text) {
  const missing = Object.entries(IM_HEALTH_PATTERNS).filter(([, re]) => !re.test(text)).map(([name]) => name);
  return {missing};
}

function versionFact(target) {
  try {
    const installed = JSON.parse(readFileSync(join(process.env.HOME ?? '', '.dsh/profiles/desktop/node_modules/dsh-personal-workstation/package.json'), 'utf8'));
    const repo = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    return {installed: installed.version, repo: repo.version};
  } catch { return {installed: '读不到', repo: '读不到'}; }
}

async function main() {
  const target = await findLiveTarget();
  const browser = await launchBrowser();
  let data, canaries = [];
  try {
    data = await collect(target, browser);
    if (withCanary) canaries = await liveCanary(target, browser);
  } finally {
    await browser.close();
  }
  data.settings.health = healthOf(data.settings.imText || data.settings.text || '');
  data.versions = versionFact(target);

  const results = runChecks(data);
  const pureCanaries = canaryReport();
  const canaryCaught = pureCanaries.filter(c => c.caught).length;
  data.canaries = {pure: pureCanaries, live: canaries};
  data.results = results;

  if (jsonOnly) {
    console.log(JSON.stringify(data, null, 1));
    writeFileSync(REPORT, JSON.stringify(data, null, 1));
    const bad = results.filter(r => r.fail).length + (canaryCaught < pureCanaries.length ? 1 : 0);
    process.exit(bad ? 1 : 0);
  }

  console.log('语义门禁 v1（17 号约束 §3）· 真实实例 + 真实数据');
  console.log('实例：' + target.base + '　已装 ' + data.versions.installed + ' · 仓库 ' + data.versions.repo);
  console.log('采集：' + data.collectedAt + '　截图：' + (jsonOnly ? '（未截）' : SHOTS));
  console.log('');
  let total = 0, failures = 0;
  for (const row of results) {
    total += row.count;
    if (row.fail) failures += 1;
    console.log((row.fail ? 'FAIL ' : 'PASS ') + row.id.padEnd(4) + row.title.padEnd(18) + ' 违规 ' + String(row.count).padStart(3) + ' 处　（' + row.ref + '）');
    for (const v of row.violations.slice(0, 6)) {
      console.log('      · [' + v.where + '] ' + v.what + (v.value !== undefined ? '（' + JSON.stringify(v.value) + '）' : '') + (v.sample ? ' 例：' + JSON.stringify(v.sample).slice(0, 120) : ''));
    }
    if (row.violations.length > 6) console.log('      · …还有 ' + (row.violations.length - 6) + ' 类');
  }
  console.log('');
  console.log('判据 canary（离线夹具）：' + canaryCaught + '/' + pureCanaries.length + ' 抓到');
  for (const c of pureCanaries.filter(x => !x.caught)) console.log('  ✗ ' + c.id + ' 没抓到：' + c.why);
  if (canaries.length) {
    const liveCaught = canaries.filter(c => c.caught).length;
    console.log('测量 canary（实时注入）：' + liveCaught + '/' + canaries.length + ' 响应');
    for (const c of canaries.filter(x => !x.caught)) console.log('  ✗ ' + c.id + ' 没响应：' + c.what);
  }
  console.log('');
  console.log('总计：' + results.length + ' 项判据，' + failures + ' 项未通过，违规 ' + total + ' 处。');
  console.log(failures ? 'FAIL：真实界面未达到 17 §3 语义判据（这是真实实例上的测量，不是夹具）。' : 'PASS：真实界面通过 17 §3 的 10 项可机械化判据。');
  writeFileSync(REPORT, JSON.stringify(data, null, 1));
  console.log('报告：' + REPORT);
  process.exit(failures || canaryCaught < pureCanaries.length || (canaries.length && canaries.some(c => !c.caught)) ? 1 : 0);
}

main().catch(error => {
  console.error('语义门禁跑不起来（不是通过，是没测到）：' + error.message);
  process.exit(1);
});
