#!/usr/bin/env node
/** **W0 基线证据包**：对着「正在运行的 DSH 实例 + 真实数据」截 15 张图，并落一份可复跑的 metadata。
 *
 *  为什么要它（spec/26 §3 W0-3）：后面 W1/W2/W5 每改一版都要拿同一批页面来比，
 *  没有基线就只能靠记忆说"好像好点了"。基线必须是**真实实例、真实库**上的画面，
 *  不能用夹具截图 —— 夹具里没有用户的 30 个真实对象，也照不出"看到的 ≠ 装的"。
 *
 *  产出（缺一不可）：
 *    · 桌面 1440×940：7 个一级视图（home/inbox/space/projects/tasks/knowledge/personal）
 *    · 手机 390×844：4 页（home/tasks/inbox/knowledge）
 *    · 额外桌面 4 张：设置弹窗 / 项目「选择文件夹」面板 / 助理入口弹窗 / 画布（space）
 *    · metadata.json：时间、实例、三个版本、**三个 space-view.mjs sha256**、
 *      真实库只读副本（.backup 到工作区外）+ entities.kind 统计、每张图的 sha256/像素/视口/标题
 *
 *  **只读纪律**（2026-10-17 46 审计的教训：点画布缩放触发了 4 次 layout 写入）：
 *    · 不点保存 / 同意 / 撤销 / 画布缩放 / 全图 / 拖拽；打开弹窗只看，一律 Escape 关闭；
 *    · 进 / 出各拍一次真实库 .backup 副本，比较 layout revision 与各表行数；
 *      一旦有变化，**如实写进 metadata 并打印"检测到写入"**，绝不掩盖。
 *
 *  凭据：只取 DSH 桌面端 Chromium Cookies 库里的会话名，**不打印 cookie 值**。
 *
 *  用法：node workstation/prototype/baseline-capture.mjs
 *  输出：spec/screenshots/47-基线-20261017/（同名文件覆盖，不删其他文件）
 */
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {findLiveTarget, launchBrowser, openPage, gotoView, wait, CHROME} from './live-target.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const workstationRoot = join(here, '..');                     // …/workstation
const workspaceRoot = join(workstationRoot, '..');             // …/飞书工作区
const SHOTS = join(workspaceRoot, 'spec', 'screenshots', '47-基线-20261017');
const DB_PATH = join(workspaceRoot, 'workstation-data', 'workstation.sqlite');
const BACKUP = '/tmp/w0-baseline.sqlite';                      // 产出：真实库只读副本（工作区外）
const BACKUP_BEFORE = '/tmp/w0-baseline-before.sqlite';        // 只用于检测"跑这一趟有没有写入"
const installedDir = join(process.env.HOME ?? '', '.dsh/profiles/desktop/node_modules/dsh-personal-workstation');

const NOW = new Date();
const failures = [];
const notes = [];
const shots = [];

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const sha256File = path => sha256(readFileSync(path));
const short = value => (value ? String(value).slice(0, 12) + '…' : '（空）');
const fail = (label, error) => {
  const message = label + '：' + (error?.message ?? error);
  failures.push(message);
  console.log('  ✗ ' + message);
};
const step = async (label, fn) => {
  try {
    return await fn();
  } catch (error) {
    fail(label, error);
    return null;
  }
};

/** PNG 头部里读真实像素尺寸（不引第三方库、不 decode）。 */
function pngSize(buffer) {
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') return {width: null, height: null};
  return {width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20)};
}

// ── SQLite：只读副本（.backup），不直接读 WAL 主库 ─────────────────────────────
function sqlite(copyPath, query) {
  return execFileSync('/usr/bin/sqlite3', ['-separator', '|', copyPath, query], {encoding: 'utf8'}).trimEnd();
}
function tableCount(copyPath, table) {
  try { return Number(sqlite(copyPath, 'select count(*) from ' + table + ';')); } catch { return null; }
}
function snapshotDatabase(label, targetPath) {
  if (!existsSync(DB_PATH)) throw new Error('找不到真实库：' + DB_PATH);
  const main = statSync(DB_PATH);
  const walPath = DB_PATH + '-wal';
  const wal = existsSync(walPath) ? statSync(walPath) : {size: 0};
  execFileSync('/usr/bin/sqlite3', [DB_PATH, '.backup ' + targetPath], {encoding: 'utf8'});
  const copy = readFileSync(targetPath);
  const rows = sqlite(targetPath, 'select kind, count(*) from entities where archived = 0 group by kind order by count(*) desc;')
    .split('\n').filter(Boolean)
    .map(line => {
      const at = line.lastIndexOf('|');
      return {kind: line.slice(0, at), count: Number(line.slice(at + 1))};
    });
  const kinds = {};
  for (const row of rows) kinds[row.kind] = row.count;
  const layoutRevision = sqlite(targetPath, "select revision from entities where kind = 'layout' limit 1;");
  const layoutData = sqlite(targetPath, "select data from entities where kind = 'layout' limit 1;");
  return {
    label,
    at: new Date().toISOString(),
    backup: {path: targetPath, bytes: copy.length, sha256: sha256(copy)},
    source: {path: DB_PATH, bytes: main.size, mtime: new Date(main.mtimeMs).toISOString(), walBytes: wal.size},
    entities: {
      active: Number(sqlite(targetPath, 'select count(*) from entities where archived = 0;')),
      archived: Number(sqlite(targetPath, 'select count(*) from entities where archived = 1;')),
      byKind: kinds,
    },
    layout: {present: Boolean(layoutRevision), revision: layoutRevision ? Number(layoutRevision) : null, dataSha256: layoutData ? sha256(Buffer.from(layoutData)) : null},
    otherTables: Object.fromEntries(['tombstones', 'heartbeat_runs', 'receipts', 'executions', 'audit', 'batches', 'speak_feedback']
      .map(table => [table, tableCount(targetPath, table)])),
  };
}

/** 进 / 出两次快照的比较：只认"库里的行真的变了"，不猜。 */
function compareSnapshots(before, after) {
  if (!before || !after) return {writesDetected: null, changes: [], note: '快照缺失，无法判定'};
  const changes = [];
  if (before.layout.revision !== after.layout.revision) changes.push('layout revision：' + before.layout.revision + ' → ' + after.layout.revision);
  if (before.layout.dataSha256 !== after.layout.dataSha256) changes.push('layout 数据正文哈希变化');
  for (const kind of new Set([...Object.keys(before.entities.byKind), ...Object.keys(after.entities.byKind)])) {
    const from = before.entities.byKind[kind] ?? 0;
    const to = after.entities.byKind[kind] ?? 0;
    if (from !== to) changes.push('entities.' + kind + '：' + from + ' → ' + to);
  }
  if (before.entities.active !== after.entities.active) changes.push('entities 总数：' + before.entities.active + ' → ' + after.entities.active);
  for (const table of Object.keys(after.otherTables)) {
    const from = before.otherTables[table];
    const to = after.otherTables[table];
    if (from !== null && to !== null && from !== to) changes.push(table + '：' + from + ' → ' + to);
  }
  const mainTouched = before.source.mtime !== after.source.mtime || before.source.walBytes !== after.source.walBytes;
  return {
    writesDetected: changes.length > 0 || mainTouched,
    changes,
    mainFileTouched: mainTouched,
    layoutRevisionBefore: before.layout.revision,
    layoutRevisionAfter: after.layout.revision,
  };
}

// ── 截图 ────────────────────────────────────────────────────────────────────
async function pageIdentity(page) {
  return page.evaluate(() => ({
    title: document.title,
    crumb: document.querySelector('#crumb')?.textContent?.trim() ?? null,
    subtitle: document.querySelector('#subtitle')?.textContent?.trim() ?? null,
    activeView: document.querySelector('.view.active')?.id ?? null,
    veilOpen: Boolean(document.querySelector('#veil')?.classList.contains('open')),
  }));
}
async function capture(page, {file, label, view, viewport, isMobile = false, dialog = null, extra = null}) {
  const path = join(SHOTS, file);
  await page.screenshot({path});
  const buffer = readFileSync(path);
  const identity = await pageIdentity(page);
  const size = pngSize(buffer);
  shots.push({
    file,
    label,
    view,
    isMobile,
    viewport,
    pixelWidth: size.width,
    pixelHeight: size.height,
    bytes: buffer.length,
    sha256: sha256(buffer),
    capturedAt: new Date().toISOString(),
    pageTitle: identity.title,
    crumb: identity.crumb,
    subtitle: identity.subtitle,
    activeView: identity.activeView,
    ...(dialog ? {dialog} : {}),
    ...(extra ? {extra} : {}),
  });
  console.log('  ✓ ' + file + '  ' + size.width + '×' + size.height + '  ' + short(sha256(buffer)) + (dialog ? '  «' + dialog.title + '»' : ''));
  return shots[shots.length - 1];
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
mkdirSync(SHOTS, {recursive: true});
console.log('W0 基线证据包 · 真实实例 + 真实数据');
console.log('输出目录：' + SHOTS);

const target = await step('发现实例与登录凭据', () => findLiveTarget());
if (!target) {
  console.log('FAIL: 找不到能打开工作台的实例 —— 这不是"通过"，是没测到。');
  process.exit(1);
}
// 凭据只记录"配对成功"这件事本身：cookie **名字**里也带随机会话 token，所以名字和值都不落盘。
console.log('实例：' + target.base + '（候选 ' + target.candidates.length + ' 个端口 · 凭据来源：DSH 桌面端 Chromium Cookies（127.0.0.1）· 已配对）');

// ① 版本与哈希（三个 space-view.mjs：服务器实际发出的 / 已装包 / 仓库）──────────
const repoPkg = JSON.parse(readFileSync(join(workstationRoot, 'package.json'), 'utf8'));
const installedPkg = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'));
let servedHash = null, installedHash = null, repoHash = null, servedStatus = null;
servedHash = await step('取服务器实际发出的 space-view.mjs', async () => {
  const response = await fetch(target.base + '/personal-workstation/v7/space-view-v5.mjs', {headers: {cookie: target.cookie}});
  servedStatus = response.status;
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return sha256(Buffer.from(await response.arrayBuffer()));
});
installedHash = await step('取已装包 space-view.mjs', () => sha256File(join(installedDir, 'src/v7/space-view-v5.mjs')));
repoHash = await step('取仓库 space-view.mjs', () => sha256File(join(workstationRoot, 'src/v7/space-view-v5.mjs')));
const servedEqualsInstalled = Boolean(servedHash && installedHash && servedHash === installedHash);
const installedEqualsRepo = Boolean(installedHash && repoHash && installedHash === repoHash);
if (servedHash && installedHash && !servedEqualsInstalled) {
  const sentence = '看到的 ≠ 装的：服务器实际发出的 space-view.mjs（' + short(servedHash) + '）≠ 已装包（' + short(installedHash) + '）'
    + (installedEqualsRepo ? '，而已装包 = 仓库' : '')
    + ' —— 以为改完了，用户打开的还是旧代码。';
  notes.push(sentence);
  console.log('  ⚠ ' + sentence);
}
console.log('版本：仓库 ' + repoPkg.version + ' · 已装包 ' + installedPkg.version + ' · 服务器实际发出 ' + short(servedHash)
  + (installedEqualsRepo ? '（已装包 = 仓库）' : '（已装包 ≠ 仓库）'));

// ② 进库前快照（只读副本）────────────────────────────────────────────────────
const before = await step('取运行前库快照', () => snapshotDatabase('before', BACKUP_BEFORE));
if (before) console.log('库（运行前副本）：' + before.entities.active + ' 个对象 / ' + Object.keys(before.entities.byKind).length + ' 类 · layout rev ' + before.layout.revision);

// ③ 浏览器：桌面 7 页 + 4 张额外 + 手机 4 页 ─────────────────────────────────
const DESKTOP = {width: 1440, height: 940};
const MOBILE = {width: 390, height: 844};
const VIEWS = [
  ['home', '总览', '01-桌面-总览.png'],
  ['inbox', '收件箱', '02-桌面-收件箱.png'],
  ['space', '关联空间', '03-桌面-关联空间.png'],
  ['projects', '项目', '04-桌面-项目.png'],
  ['tasks', '任务', '05-桌面-任务.png'],
  ['knowledge', '知识', '06-桌面-知识.png'],
  ['personal', '日程与事务', '07-桌面-日程与事务.png'],
];

const browser = await launchBrowser();
try {
  // —— 桌面 ——
  const page = await openPage(browser, target, {...DESKTOP, settle: 2000});
  console.log('桌面 ' + DESKTOP.width + '×' + DESKTOP.height + '：');
  const desktopIdentity = await pageIdentity(page);
  console.log('  页面标题「' + desktopIdentity.title + '」 · 副标题「' + desktopIdentity.subtitle + '」');

  for (const [view, label, file] of VIEWS) {
    await gotoView(page, view, view === 'space' ? 2400 : 1400);
    await capture(page, {file, label, view, viewport: DESKTOP});
  }

  // 额外 ① 设置弹窗（#settings 是侧栏底部按钮）—— 只看，Escape 关。
  const settings = await step('设置弹窗', async () => {
    await gotoView(page, 'home', 1200);
    const opened = await page.evaluate(() => {
      const button = document.querySelector('#settings');
      if (!button) return false;
      button.click();
      return true;
    });
    await wait(2200);
    const state = await page.evaluate(() => ({
      open: Boolean(document.querySelector('#veil')?.classList.contains('open')),
      text: document.querySelector('#veil')?.innerText ?? '',
    }));
    const text = state.text;
    const version = /dsh-personal-workstation\s+([0-9]+\.[0-9]+\.[0-9]+)/.exec(text)?.[1] ?? null;
    const uiAssets = /界面资源[^\n]*/.exec(text)?.[0] ?? null;
    const dataRoot = /数据根目录\n([^\n]+)/.exec(text)?.[1]?.trim() ?? null;
    await capture(page, {
      file: '08-桌面-设置弹窗.png', label: '设置弹窗', view: 'settings', viewport: DESKTOP,
      dialog: {title: '设置', opened, open: state.open, textSnippet: text.replace(/\s+/g, ' ').slice(0, 400)},
    });
    await page.keyboard.press('Escape');
    await wait(700);
    const closed = !(await page.evaluate(() => Boolean(document.querySelector('#veil')?.classList.contains('open'))));
    console.log('    设置：版本文本 ' + (version ?? '（没读到）') + ' · 界面资源 ' + (uiAssets ?? '（没读到）') + ' · 关闭=' + closed);
    return {opened, open: state.open, closed, version, uiAssets, dataRoot, textSnippet: text.replace(/\s+/g, ' ').slice(0, 1200)};
  });

  // 额外 ② 项目「选择文件夹」面板：项目页 → 第一张项目卡 → 编辑项目 → 选择文件夹。
  //        只**展开**看，不点任何候选、不保存、不取消数据，Escape 关。
  const folderPanel = await step('项目「选择文件夹」面板', async () => {
    await gotoView(page, 'projects', 1600);
    const card = await page.evaluate(() => {
      const element = document.querySelector('button.project.surface[data-project]');
      if (!element) return null;
      const info = {id: element.dataset.project, text: (element.innerText || '').replace(/\s+/g, ' ').slice(0, 80)};
      element.click();
      return info;
    });
    if (!card) throw new Error('项目页没有项目卡');
    await wait(1600);
    const editOpened = await page.evaluate(() => {
      const button = document.querySelector('#newprojectedit');
      if (!button) return false;
      button.click();
      return true;
    });
    if (!editOpened) throw new Error('项目详情里没有 #newprojectedit（编辑项目）');
    await wait(1800);
    const formTitle = await page.evaluate(() => document.querySelector('#detailtitle')?.textContent?.trim() ?? null);
    const picked = await page.evaluate(() => {
      const button = [...document.querySelectorAll('#veil button')].find(element => element.textContent.trim() === '选择文件夹');
      if (!button) return false;
      button.click();
      return true;
    });
    if (!picked) throw new Error('编辑项目表单里没有「选择文件夹」按钮');
    await wait(2400);
    // 面板在表单下半部分，首屏看不到 —— 用 scrollIntoView 把它滚进视口（只滚动，不点任何候选项）。
    await page.evaluate(() => document.querySelector('[data-folderpanel]')?.scrollIntoView({block: 'center', behavior: 'instant'}));
    await wait(800);
    const panel = await page.evaluate(() => {
      const node = document.querySelector('[data-folderpanel]');
      const box = node?.getBoundingClientRect();
      return {
        open: Boolean(document.querySelector('#veil')?.classList.contains('open')),
        text: (node?.innerText ?? '').replace(/\s+/g, ' ').trim(),
        options: [...document.querySelectorAll('[data-folder-option]')].map(element => element.getAttribute('data-folder-option')),
        box: box ? {x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height)} : null,
        scrolledIntoView: Boolean(box && box.top >= 0 && box.bottom <= window.innerHeight),
      };
    });
    await capture(page, {
      file: '09-桌面-项目文件夹面板.png', label: '项目「选择文件夹」面板', view: 'projects', viewport: DESKTOP,
      dialog: {title: formTitle ?? '编辑项目', opened: true, open: panel.open, textSnippet: panel.text.slice(0, 400), optionCount: panel.options.length, scrolledIntoView: panel.scrolledIntoView, clickedAnyOption: false},
    });
    await page.keyboard.press('Escape');
    await wait(800);
    let closed = !(await page.evaluate(() => Boolean(document.querySelector('#veil')?.classList.contains('open'))));
    if (!closed) { await page.keyboard.press('Escape'); await wait(700); closed = !(await page.evaluate(() => Boolean(document.querySelector('#veil')?.classList.contains('open')))); }
    console.log('    文件夹面板：项目 ' + card.id + ' · 「' + (formTitle ?? '编辑项目') + '」· 候选项 ' + panel.options.length
      + ' 个 · 已滚入视口=' + panel.scrolledIntoView + ' · 未点任何候选项/未保存 · 关闭=' + closed);
    return {projectId: card.id, projectText: card.text, formTitle, opened: true, open: panel.open, closed, optionCount: panel.options.length, options: panel.options, panelBox: panel.box, scrolledIntoView: panel.scrolledIntoView, clickedAnyOption: false, textSnippet: panel.text.slice(0, 600)};
  });

  // 额外 ③ 助理入口弹窗（#assistant）—— 只看，Escape 关。
  const assistant = await step('助理入口弹窗', async () => {
    await page.evaluate(() => document.querySelector('#assistant')?.click());
    await wait(1400);
    const state = await page.evaluate(() => ({
      open: Boolean(document.querySelector('#veil')?.classList.contains('open')),
      title: document.querySelector('#detailtitle')?.textContent?.trim() ?? null,
      text: (document.querySelector('#veil')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 400),
    }));
    await capture(page, {
      file: '10-桌面-助理弹窗.png', label: '助理入口弹窗', view: 'assistant', viewport: DESKTOP,
      dialog: {title: state.title ?? '助理', opened: state.open, open: state.open, textSnippet: state.text},
    });
    await page.keyboard.press('Escape');
    await wait(700);
    const closed = !(await page.evaluate(() => Boolean(document.querySelector('#veil')?.classList.contains('open'))));
    console.log('    助理：打开=' + state.open + ' · 关闭=' + closed);
    return {...state, closed};
  });

  // 额外 ④ 画布（space 视图）：**只截图**。绝不点缩放/全图/保存/拖拽。
  const canvas = await step('画布（space 视图）', async () => {
    await gotoView(page, 'space', 2800);
    const state = await page.evaluate(() => {
      const svg = document.querySelector('#spaceSvg');
      const box = svg?.getBoundingClientRect();
      const zoom = [...document.querySelectorAll('#space *')]
        .filter(element => element.children.length === 0 && /^\d+%$/.test((element.textContent || '').trim()))
        .map(element => element.textContent.trim())[0] ?? null;
      return {
        hasCanvas: Boolean(svg),
        svgBox: box ? {x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height)} : null,
        zoom,
        status: (document.querySelector('#graphstatus')?.innerText ?? '').replace(/\s+/g, ' ').trim() || null,
      };
    });
    await capture(page, {
      file: '11-桌面-画布.png', label: '画布（space 视图）', view: 'space', viewport: DESKTOP,
      extra: {title: '画布（space 视图）', controlsClicked: false, zoom: state.zoom, status: state.status},
    });
    console.log('    画布：' + (state.hasCanvas ? '已渲染' : '未渲染') + ' · 缩放 ' + (state.zoom ?? '（没读到）') + ' · 未点任何画布控件');
    return state;
  });

  // —— 手机 390×844 ——
  console.log('手机 ' + MOBILE.width + '×' + MOBILE.height + '：');
  const mobilePage = await openPage(browser, target, {...MOBILE, mobile: true, settle: 2200});
  const mobileViews = [
    ['home', '总览', '12-手机-总览.png'],
    ['tasks', '任务', '13-手机-任务.png'],
    ['inbox', '收件箱', '14-手机-收件箱.png'],
    ['knowledge', '知识', '15-手机-知识.png'],
  ];
  for (const [view, label, file] of mobileViews) {
    await gotoView(mobilePage, view, 1600);
    await capture(mobilePage, {file, label, view, viewport: MOBILE, isMobile: true});
  }
  await mobilePage.close();

  // ④ 出库后快照：和运行前比，确认这一趟没有写任何东西 ─────────────────────────
  const after = await step('取运行后库快照', () => snapshotDatabase('after', BACKUP));
  const writeCheck = compareSnapshots(before, after);
  if (writeCheck.writesDetected) {
    const disclosure = '检测到写入（' + writeCheck.changes.join('；') + '）—— 基线采集期间真实库发生变化，已如实记录。';
    notes.push(disclosure);
    console.log('  ⚠ ' + disclosure);
  } else {
    console.log('库（运行后副本）：' + after.entities.active + ' 个对象 / ' + Object.keys(after.entities.byKind).length + ' 类 · layout rev ' + after.layout.revision + ' · 未检测到写入');
  }

  // ⑤ metadata ────────────────────────────────────────────────────────────
  const expectedShots = 15;
  const versionConsistent = {
    servedVersion: settings?.version ?? null,
    repoVersion: repoPkg.version,
    installedVersion: installedPkg.version,
    stringsAgree: Boolean(settings?.version && settings.version === installedPkg.version),
    hashesAgree: servedEqualsInstalled,
    verdict: servedEqualsInstalled
      ? '服务器实际发出的 = 已装包 = 仓库'
      : '版本号字符串 ' + (settings?.version ?? '?') + ' 一致，但 space-view.mjs 正文不一致 —— 看到的 ≠ 装的',
  };
  const metadata = {
    schema: 'w0-baseline/1',
    generatedAt: NOW.toISOString(),
    generator: 'workstation/prototype/baseline-capture.mjs',
    target: {
      base: target.base,
      pageUrl: target.pageUrl,
      portCandidates: target.candidates.length,
      credential: {source: 'DSH 桌面端 Chromium Cookies（127.0.0.1）', note: '只记录来源；cookie 名/值都含会话 token，一律不落盘'},
      node: process.version,
      chrome: CHROME,
    },
    versions: {
      repo: {version: repoPkg.version, packageJson: join(workstationRoot, 'package.json')},
      installed: {version: installedPkg.version, packageJson: join(installedDir, 'package.json')},
      served: {version: settings?.version ?? null, source: '设置弹窗 DOM', uiAssetsLabel: settings?.uiAssets ?? null, dataRoot: settings?.dataRoot ?? null},
      consistent: versionConsistent,
    },
    hashes: {
      spaceView: {
        served: servedHash,
        servedHttpStatus: servedStatus,
        installed: installedHash,
        repo: repoHash,
        servedEqualsInstalled,
        installedEqualsRepo,
      },
    },
    database: {
      source: DB_PATH,
      backup: after ? {path: after.backup.path, bytes: after.backup.bytes, sha256: after.backup.sha256, at: after.at} : null,
      entities: after ? {active: after.entities.active, archived: after.entities.archived, byKind: after.entities.byKind} : null,
      layout: after ? after.layout : null,
      otherTables: after ? after.otherTables : null,
      readOnlyCheck: {...writeCheck, before: before ? {at: before.at, backup: before.backup, entities: before.entities, layout: before.layout} : null, after: after ? {at: after.at, backup: after.backup, entities: after.entities, layout: after.layout} : null},
    },
    dialogs: {settings, folderPanel, assistant, canvas},
    screenshots: shots,
    summary: {
      desktopViews: VIEWS.length,
      mobileViews: mobileViews.length,
      extraDesktop: 4,
      screenshotCount: shots.length,
      expectedScreenshots: expectedShots,
      allDimensionsMatchViewport: shots.every(shot => shot.pixelWidth === shot.viewport.width && shot.pixelHeight === shot.viewport.height),
      missingShots: expectedShots - shots.length,
      writesDetected: writeCheck.writesDetected,
      hashVerdict: versionConsistent.verdict,
    },
    failures,
    notes,
  };
  writeFileSync(join(SHOTS, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');

  console.log('');
  console.log('metadata.json：' + join(SHOTS, 'metadata.json'));
  console.log('截图 ' + shots.length + ' / ' + expectedShots + ' 张 · 版本 仓库/已装/服务端 = '
    + repoPkg.version + '/' + installedPkg.version + '/' + (settings?.version ?? '（未读到）')
    + ' · space-view 哈希 ' + (servedEqualsInstalled ? '一致' : '不一致（看到的 ≠ 装的）'));
  if (notes.length) { console.log('需要披露：'); for (const note of notes) console.log('  ⚠ ' + note); }

  const verdict = shots.length >= expectedShots && !failures.length;
  if (!verdict && failures.length) { console.log('FAIL: ' + failures.length + ' 项没完成：' + failures.join('；')); }
  if (verdict) {
    console.log('结论：基线证据包完成 —— ' + shots.length + ' 张截图（桌面 7 + 额外 4 + 手机 4）· 版本 ' + installedPkg.version
      + ' · 三个 space-view 哈希 ' + (servedEqualsInstalled ? '一致' : '不一致（served ' + short(servedHash) + ' ≠ installed/repo ' + short(installedHash) + '，看到的 ≠ 装的）')
      + ' · 真实库 ' + (after?.entities.active ?? '?') + ' 个对象（' + Object.keys(after?.entities.byKind ?? {}).length + ' 类）· 写入检测：'
      + (writeCheck.writesDetected ? '检测到写入（已披露）' : '无'));
    process.exit(0);
  }
  process.exit(1);
} catch (error) {
  fail('基线采集主流程', error);
  console.log('FAIL: 基线采集没跑完（' + failures.length + ' 项）：' + failures.join('；'));
  process.exit(1);
} finally {
  await browser.close().catch(() => {});
}
