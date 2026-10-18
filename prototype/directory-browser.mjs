#!/usr/bin/env node
/** 工作区目录浏览器（全站唯一实现）——文件夹选择与"再授权一个文件夹"共用。
 *
 *  为什么抽出来：旧实现有两段各自手写的目录浏览（editor.mjs 的「项目文件夹」与 inbox.mjs 的授权面板），
 *  都从**非法存量值**开始、失败后直接 return 留下空白面板、进入空目录后无法选当前目录。46 号审计
 *  实测「选择文件夹」必失败且无出路。这里做成一份：根目录起点 / 面包屑 / 上级 / 回根 / 选这个文件夹，
 *  四态齐全，失败永远有一个可点的下一步。
 *
 *  边界：只通过 `directory_list` / `directory_create` 访问工作区内目录，自己不做文件系统判断。
 *  用法：
 *    import {mountDirectoryBrowser, suggestFolders, renderFolderCandidates, humanFolderError} from './directory-browser.mjs';
 */

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
const cleanPath = value => String(value ?? '').replace(/^\/+|\/+$/g, '').trim();
const baseName = value => cleanPath(value).split('/').filter(Boolean).pop() ?? '';

/** 把目录接口的失败翻译成一句人话（保存校验与浏览面板共用）。 */
export function humanFolderError(error, path) {
  const code = error?.code ?? '';
  const message = String(error?.message ?? '读不到这个文件夹');
  if (code === 'NOT_FOUND' || /目录不存在|不存在/.test(message)) return '工作区里没有「' + (cleanPath(path) || '这个文件夹') + '」这个文件夹';
  if (code === 'FORBIDDEN' || /跳出工作区|不在工作区|只能访问/.test(message)) return '这个文件夹不在工作区里，不能选';
  if (code === 'INVALID' && /绝对路径/.test(message)) return '请使用工作区里的相对路径，不要用绝对路径';
  return '读不到这个文件夹：' + message.replace(/^无法读取工作区目录：/, '');
}

/** 规范化用于候选匹配：去掉空格、连接符、括号、斜杠，统一小写。 */
const normalize = value => String(value ?? '').toLowerCase().replace(/[\s·・_\-—–/\\（）()【】[\]]/g, '');

/**
 * 按标题找相似文件夹（确定性、可测）：列根目录 → 每个根目录下再列一层（最多 40 个目录），
 * 用「标题包含目录名」打分，命中按名字长度降序；没有命中就返回根目录前几个（保证永远有候选）。
 * 不 hardcode 任何路径。
 */
export async function suggestFolders(send, title, {limit = 5, maxDirs = 40, roots = 20} = {}) {
  const result = [];
  const seen = new Set();
  let rootData;
  try { rootData = await send('directory_list', { path: '' }); } catch { return []; }
  const rootItems = (rootData?.items ?? []).slice(0, roots);
  for (const item of rootItems) {
    if (result.length >= maxDirs) break;
    seen.add(item.path);
    let children = [];
    try { children = (await send('directory_list', { path: item.path }))?.items ?? []; } catch {}
    for (const child of children.slice(0, maxDirs)) if (!seen.has(child.path)) { seen.add(child.path); result.push(child); }
  }
  const wanted = normalize(title);
  const hits = wanted
    ? result.filter(item => normalize(item.name).length >= 2 && wanted.includes(normalize(item.name)))
    : [];
  if (hits.length) return hits.sort((a, b) => normalize(b.name).length - normalize(a.name).length).slice(0, limit);
  const rootsOnly = rootItems.slice(0, limit);
  return rootsOnly.length ? rootsOnly : result.slice(0, limit);
}

/** 渲染候选（"可能是这个：" + 可点候选）。调用方负责在点中后把值写回输入框。 */
export function renderFolderCandidates(container, candidates, onPick) {
  const doc = container.ownerDocument;
  container.replaceChildren();
  if (!candidates?.length) {
    const none = doc.createElement('p');
    none.className = 'formhint';
    none.dataset.folderNoCandidate = '1';
    none.textContent = '没有找到相似的文件夹。';
    container.append(none);
    return;
  }
  const label = doc.createElement('p');
  label.className = 'formhint';
  label.textContent = '可能是这个：';
  container.append(label);
  for (const item of candidates) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.dataset.folderCandidate = item.path;
    button.textContent = item.path;
    button.onclick = () => onPick?.(item.path, item);
    container.append(button);
  }
}

/**
 * 把目录浏览器挂到容器上。
 * options: {document, send, notify, initialPath, title, allowCreate, selectLabel, onSelect, onInvalidPath}
 * 返回 {go, refresh, path, dispose}。
 */
export function mountDirectoryBrowser(container, options = {}) {
  const doc = options.document ?? container.ownerDocument;
  const send = options.send;
  const notify = typeof options.notify === 'function' ? options.notify : () => {};
  const selectLabel = options.selectLabel ?? '选这个文件夹';
  const allowCreate = options.allowCreate === true;
  let title = options.title ?? '';
  let path = cleanPath(options.initialPath);
  let data = null;
  let status = 'loading';
  let disposed = false;
  let seq = 0;
  let invalidHandled = false;
  let warnText = '';   // 原路径不可用的提示：切换目录后仍要保留，直到用户选了新目录

  container.classList.add('folderbrowser');
  container.innerHTML = ''
    + '<p class="formhint folderwarn" data-folder-warn hidden></p>'
    + '<div class="folderbar"><nav class="foldercrumbs" data-folderpath aria-label="当前文件夹"></nav>'
    + '<span class="folderbuttons"><button class="btn" type="button" data-folder-up>上级</button>'
    + '<button class="btn" type="button" data-folder-root>回根目录</button></span></div>'
    + '<div class="folderlist" data-folder-list aria-live="polite"></div>'
    + '<div class="foldercandidates" data-folder-candidates hidden></div>'
    + '<div class="foldercreate" data-folder-create-row hidden><input data-folder-newname placeholder="新建文件夹名称" aria-label="新建文件夹名称"><button class="btn" type="button" data-folder-create>新建文件夹</button></div>'
    + '<div class="folderactions"><button class="btn primary" type="button" data-folder-select>' + esc(selectLabel) + '</button>'
    + '<button class="btn" type="button" data-folder-retry hidden>重试</button></div>';

  const warn = container.querySelector('[data-folder-warn]');
  const crumbs = container.querySelector('[data-folderpath]');
  const list = container.querySelector('[data-folder-list]');
  const candidates = container.querySelector('[data-folder-candidates]');
  const upButton = container.querySelector('[data-folder-up]');
  const rootButton = container.querySelector('[data-folder-root]');
  const selectButton = container.querySelector('[data-folder-select]');
  const retryButton = container.querySelector('[data-folder-retry]');
  const createRow = container.querySelector('[data-folder-create-row]');
  const newName = container.querySelector('[data-folder-newname]');
  const createButton = container.querySelector('[data-folder-create]');
  if (allowCreate) createRow.hidden = false;

  const setStatus = next => {
    status = next;
    container.dataset.folderStatus = next;
    container.querySelectorAll('.folderloading').forEach(node => node.remove());
    if (next === 'loading') {
      const loading = doc.createElement('p');
      loading.className = 'formhint folderloading';
      loading.textContent = '正在读取文件夹…';
      list.append(loading);
    }
  };

  const renderCrumbs = () => {
    crumbs.replaceChildren();
    const rootCrumb = doc.createElement('button');
    rootCrumb.type = 'button';
    rootCrumb.className = 'crumbbutton';
    rootCrumb.dataset.folderCrumb = '';
    rootCrumb.textContent = '工作区';
    crumbs.append(rootCrumb);
    const parts = cleanPath(path).split('/').filter(Boolean);
    let acc = '';
    for (const part of parts) {
      acc = acc ? acc + '/' + part : part;
      crumbs.append(doc.createTextNode(' / '));
      if (acc === cleanPath(path)) {
        const current = doc.createElement('span');
        current.className = 'crumbcurrent';
        current.setAttribute('aria-current', 'location');
        current.textContent = part;
        crumbs.append(current);
      } else {
        const crumb = doc.createElement('button');
        crumb.type = 'button';
        crumb.className = 'crumbbutton';
        crumb.dataset.folderCrumb = acc;
        crumb.textContent = part;
        crumbs.append(crumb);
      }
    }
  };

  const renderList = () => {
    list.replaceChildren();
    const items = data?.items ?? [];
    upButton.disabled = !cleanPath(path);
    if (!items.length) {
      setStatus('empty');
      const empty = doc.createElement('p');
      empty.className = 'formhint';
      empty.textContent = '这个文件夹里没有子文件夹。';
      list.append(empty);
      return;
    }
    setStatus('list');
    for (const item of items) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'folderitem';
      button.dataset.folderEnter = item.path;
      button.innerHTML = '<span class="foldername">' + esc(item.name) + '</span><span class="foldergo" aria-hidden="true">›</span>';
      list.append(button);
    }
  };

  const renderCandidates = async (fromTitle) => {
    candidates.hidden = false;
    candidates.replaceChildren();
    const loading = doc.createElement('p');
    loading.className = 'formhint';
    loading.textContent = '正在找相似的文件夹…';
    candidates.append(loading);
    const items = await suggestFolders(send, fromTitle ?? title);
    if (disposed || !candidates.isConnected) return;
    renderFolderCandidates(candidates, items, pick => {
      container.dispatchEvent(new CustomEvent('foldercandidate', {bubbles: true, detail: {path: pick}}));
    });
  };

  const applyData = next => {
    data = next;
    path = cleanPath(next?.path ?? path);
    renderCrumbs();
    renderList();
    if (!warnText) { candidates.hidden = true; candidates.replaceChildren(); }
    if (warnText) { warn.hidden = false; warn.textContent = warnText; }
    else { warn.hidden = true; warn.textContent = ''; }
  };

  const fail = error => {
    setStatus('error');
    list.replaceChildren();
    const message = doc.createElement('p');
    message.className = 'formhint';
    message.dataset.folderMessage = '1';
    message.textContent = humanFolderError(error, path) + '。';
    const next = doc.createElement('p');
    next.className = 'formhint';
    next.textContent = '可以点「重试」，或回到工作区根目录重新选。';
    list.append(message, next);
    retryButton.hidden = false;
    upButton.disabled = !cleanPath(path);
  };

  const load = async (nextPath, {initial = false} = {}) => {
    const request = ++seq;
    path = cleanPath(nextPath);
    retryButton.hidden = true;
    setStatus('loading');
    renderCrumbs();
    let next;
    try {
      next = await send('directory_list', { path });
    } catch (error) {
      if (disposed || request !== seq) return;
      const notFound = error?.code === 'NOT_FOUND' || /目录不存在|不存在/.test(String(error?.message ?? ''));
      if (initial && cleanPath(path) && notFound && !invalidHandled) {
        invalidHandled = true;
        warnText = '原来填的「' + cleanPath(path) + '」不在工作区里，已经从根目录开始，请重新选择。';
        warn.hidden = false;
        warn.dataset.folderWarn = '1';
        warn.textContent = warnText;
        options.onInvalidPath?.(cleanPath(path), error);
        await load('', {initial: false});
        if (disposed) return;
        await renderCandidates(title);
        return;
      }
      fail(error);
      return;
    }
    if (disposed || request !== seq) return;
    applyData(next ?? {path, items: [], parent: ''});
  };

  const onSelect = () => {
    warnText = '';
    warn.hidden = true;
    warn.textContent = '';
    options.onSelect?.(cleanPath(path), data);
  };

  const onClick = async event => {
    const target = event.target?.closest?.('[data-folder-enter],[data-folder-crumb],[data-folder-up],[data-folder-root],[data-folder-select],[data-folder-retry],[data-folder-create]');
    if (!target || disposed) return;
    if (target.dataset.folderEnter !== undefined) { await load(target.dataset.folderEnter); return; }
    if (target.dataset.folderCrumb !== undefined) { await load(target.dataset.folderCrumb); return; }
    if (target.matches('[data-folder-up]')) {
      const parent = cleanPath(path).split('/').filter(Boolean).slice(0, -1).join('/');
      await load(data?.parent ?? parent);
      return;
    }
    if (target.matches('[data-folder-root]')) { await load(''); return; }
    if (target.matches('[data-folder-retry]')) { await load(path); return; }
    if (target.matches('[data-folder-select]')) { onSelect(); return; }
    if (target.matches('[data-folder-create]')) {
      const name = String(newName.value ?? '').trim();
      if (!name) { notify('先填文件夹名称，再点新建', true); return; }
      target.disabled = true;
      try {
        const result = await send('directory_create', { path, name });
        notify('已新建文件夹：' + result.name);
        newName.value = '';
        await load(result.path ?? path);
      } catch (error) {
        notify(humanFolderError(error, path), true);
      } finally { target.disabled = false; }
    }
  };

  container.addEventListener('click', onClick);
  container.addEventListener('foldercandidate', event => {
    const picked = cleanPath(event.detail?.path);
    if (picked) { path = picked; warnText = ''; warn.hidden = true; warn.textContent = ''; options.onSelect?.(picked, null); }
  });

  load(path, {initial: true}).catch(error => { if (!disposed) fail(error); });

  return {
    get path() { return cleanPath(path); },
    go(nextPath) { invalidHandled = false; warnText = ''; return load(nextPath, {initial: true}); },
    refresh() { return load(path); },
    setTitle(nextTitle) { title = nextTitle ?? ''; },
    dispose() {
      disposed = true;
      seq += 1;
      container.removeEventListener('click', onClick);
      container.replaceChildren();
    }
  };
}
