/** 目录浏览器（W1 P0-2）的判据测试：G-FLD-3/4/5/8 + 候选算法 + canary。
 *
 *  为什么单独一个文件：`directory-browser.mjs` 是「项目文件夹」与「授权面板」共用的**唯一实现**；
 *  旧实现有两份、且都从非法存量值开始、失败后留空白面板（46 号审计实测「选择文件夹必失败且无出路」）。
 *  这里把四态与面包屑/上级/回根锁死；真实实例上的 G-FLD-1/2/12 由 live 验收跑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from '../dev-deps.mjs';
import {mountDirectoryBrowser, suggestFolders, humanFolderError} from '../prototype/directory-browser.mjs';

const doc = () => new JSDOM('<!doctype html><body></body>').window;
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async (times = 30) => { for (let index = 0; index < times; index += 1) await tick(); };
const notFound = path => { const error = Error('目录不存在：' + path); error.code = 'NOT_FOUND'; return error; };

/** 一棵小目录树：根有 会议/资料；会议下有 示例科技-3D存算一体。 */
function tree() {
  return {
    '': {path: '', parent: '', items: [{name: '会议', path: '会议'}, {name: '资料', path: '资料'}]},
    '会议': {path: '会议', parent: '', items: [{name: '示例科技-3D存算一体', path: '会议/示例科技-3D存算一体'}]},
    '资料': {path: '资料', parent: '', items: []},
    '会议/示例科技-3D存算一体': {path: '会议/示例科技-3D存算一体', parent: '会议', items: []}
  };
}

function mount({initialPath = '', send, title = '', onSelect} = {}) {
  const window = doc(), document = window.document;
  const container = document.createElement('div');
  document.body.append(container);
  const selected = [];
  const browser = mountDirectoryBrowser(container, {
    document, send, notify: () => {}, initialPath, title,
    onSelect: (path, data) => { selected.push(path); onSelect?.(path, data); }
  });
  return {window, document, container, browser, selected};
}

test('G-FLD-1：存量值不存在 → 从根目录开始 + 一句人话（不静默清空、不空白面板）', async () => {
  const data = tree();
  const send = async (action, params = {}) => {
    if (action !== 'directory_list') throw Error(action);
    const path = String(params.path ?? '');
    if (!(path in data)) throw notFound(path);
    return data[path];
  };
  const h = mount({initialPath: '示例科技-3D存算一体', send, title: '示例科技 · 3D 存算一体芯片技术适配'});
  await settle();
  const panel = h.container;
  assert.match(panel.textContent, /原来填的「示例科技-3D存算一体」不在工作区里/, '非法存量值必须有一句人话');
  assert.match(panel.textContent, /工作区/, '必须从根目录开始并显示当前位置');
  assert(panel.querySelector('[data-folder-enter="会议"]'), '必须能从根目录进入真实文件夹');
  assert(panel.querySelector('[data-folder-select]'), '任何状态下都要能选当前目录');
  assert(panel.querySelector('[data-folder-candidate="会议/示例科技-3D存算一体"]'), '必须按标题给出真实候选');
  h.browser.dispose();
});

test('G-FLD-3：读目录失败 → 面板不空白，有重试与回根目录（canary：空白面板会红）', async () => {
  const send = async () => { const error = Error('无法读取工作区目录：磁盘异常'); error.code = 'INVALID'; throw error; };
  const h = mount({initialPath: '', send});
  await settle();
  const panel = h.container;
  assert(panel.textContent.trim().length > 0, '失败态不得是空白面板（这正是 46 审计抓到的旧行为）');
  assert.match(panel.textContent, /读不到这个文件夹/);
  assert(panel.querySelector('[data-folder-retry]') && !panel.querySelector('[data-folder-retry]').hidden, '失败必须给重试');
  assert(panel.querySelector('[data-folder-root]'), '失败必须能回根目录');
  h.browser.dispose();
});

test('G-FLD-4：空目录 → 有"没有子文件夹" + 仍可选中当前目录 + 可回根', async () => {
  const data = tree();
  const send = async (action, params = {}) => { if (action === 'directory_list') return data[params.path ?? '']; throw Error(action); };
  const h = mount({initialPath: '资料', send});
  await settle();
  const panel = h.container;
  assert.match(panel.textContent, /没有子文件夹/);
  const select = panel.querySelector('[data-folder-select]');
  assert(select && !select.disabled, '空目录也必须能选当前目录（旧实现的隐藏死路）');
  assert(panel.querySelector('[data-folder-root]'), '能回根目录');
  h.browser.dispose();
});

test('G-FLD-5：越界路径（FORBIDDEN）→ 说明不在工作区 + 回根目录，不崩', async () => {
  const send = async () => { const error = Error('只能访问已授权的路径'); error.code = 'FORBIDDEN'; throw error; };
  const h = mount({initialPath: '../x', send});
  await settle();
  const panel = h.container;
  assert.match(panel.textContent, /不在工作区里/);
  assert(panel.querySelector('[data-folder-root]'));
  h.browser.dispose();
});

test('G-FLD-8：面包屑 / 上级 / 回根都能用（从深层目录回退）', async () => {
  const data = tree();
  const send = async (action, params = {}) => { if (action === 'directory_list') return data[params.path ?? '']; throw Error(action); };
  const h = mount({initialPath: '会议/示例科技-3D存算一体', send});
  await settle();
  const panel = h.container;
  assert.match(panel.textContent, /示例科技-3D存算一体/, '必须显示当前目录');
  panel.querySelector('[data-folder-crumb="会议"]').click(); await settle();
  assert.equal(h.browser.path, '会议', '点面包屑必须回到对应层级');
  panel.querySelector('[data-folder-up]').click(); await settle();
  assert.equal(h.browser.path, '', '上级必须回到根');
  panel.querySelector('[data-folder-enter="资料"]').click(); await settle();
  assert.equal(h.browser.path, '资料');
  panel.querySelector('[data-folder-root]').click(); await settle();
  assert.equal(h.browser.path, '', '回根目录必须真的回到根');
  h.browser.dispose();
});

test('选文件夹把当前路径交给调用方（≤3 次点击完成真实场景）', async () => {
  const data = tree();
  const send = async (action, params = {}) => { if (action === 'directory_list') return data[params.path ?? '']; throw Error(action); };
  const h = mount({initialPath: '', send});
  await settle();
  const panel = h.container;
  panel.querySelector('[data-folder-enter="会议"]').click(); await settle();
  panel.querySelector('[data-folder-enter="会议/示例科技-3D存算一体"]').click(); await settle();
  panel.querySelector('[data-folder-select]').click(); await settle();
  assert.deepEqual(h.selected, ['会议/示例科技-3D存算一体'], '面板内 2 次进入 + 1 次选中 = 3 次');
  h.browser.dispose();
});

test('suggestFolders 按标题匹配真实目录、不 hardcode；无命中回退到根目录候选', async () => {
  const data = tree();
  const send = async (action, params = {}) => { if (action === 'directory_list') return data[params.path ?? '']; throw Error(action); };
  const hit = await suggestFolders(send, '示例科技 · 3D 存算一体芯片技术适配与合作研判');
  assert.deepEqual(hit.map(item => item.path), ['会议/示例科技-3D存算一体'], '必须按标题命中真实目录');
  const fallback = await suggestFolders(send, '完全无关的名字');
  assert(fallback.length >= 1, '没有命中也要有候选（根目录前几个），不能给空');
  assert(fallback.some(item => item.path === '会议' || item.path === '资料'));
});

test('humanFolderError 把接口错误翻译成人话（不把堆栈/代码端给用户）', () => {
  assert.match(humanFolderError({code: 'NOT_FOUND', message: '目录不存在：x'}, 'x'), /没有「x」这个文件夹/);
  assert.match(humanFolderError({code: 'FORBIDDEN', message: '只能访问已授权的路径'}, 'x'), /不在工作区里/);
  assert.doesNotMatch(humanFolderError({code: 'NOT_FOUND', message: '目录不存在：x'}, 'x'), /NOT_FOUND|Error/);
});
