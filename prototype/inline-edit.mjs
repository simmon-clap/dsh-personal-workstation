/** 就地编辑（2026-10-14，2026-10-15 补「＋ 新建」与长文本）。
 *
 *  起因（独立走查实测）：详情里明明写着「负责人：未设置」，**点它改不了** ——
 *  改一个负责人要 6 步（开弹窗 → 滚到底 → 点「编辑项目」 → 找下拉 → 选 → 保存），
 *  而失败路径的文案还在教用户去走这 6 步。宪章五「机器做可重复的，人做要负责的」：
 *  改一个字段根本不是需要负责的分叉，它就该在**看见它的地方**一步完成。
 *
 *  所以这里是**一个**控件，全站就地编辑都用它（VI §6「同一控件唯一实现」）：
 *    · 平时是一行「标签 · 值」，值本身是个按钮（VI 四态齐全、有焦点环）；
 *    · 点它 → 值换成统一下拉（有 options）或输入框（文本/日期/多行文本）；
 *    · 改完立刻提交（自己的操作直接生效 + 可撤销），**不弹确认**（契约②）；
 *    · 提交失败就还原成原值并如实提示（不假装成功）。
 *
 *  2026-10-15 补的第一个洞（用户点名）：下拉里**只有库里已有的记录**，于是出现"有什么就选什么"
 *  —— 库里唯一的组织叫「TK」，就被错挂到别的项目上。现在下拉里有「＋ 新建组织 / 联系人」，
 *  点开就能输名字建，建完自动选中。新建这一步**复用编辑弹窗那一套**（editor.mjs 的 refCreateRow，
 *  VI §6），不另写一套：走同一条写入路径、同一句回执、同一个「建好并选中」按钮。
 *
 *  它与「编辑」弹窗的关系：弹窗留给"一次改很多字段"；改一个字段用它。
 */
import {selectHtml, wireSelects} from './vi-select.mjs';
import {refCreateRow, referenceWriter, refNoun, createdNotice} from './editor.mjs';

/** 下拉里的「＋ 新建」：一个不会与任何真实记录 id 相同的哨兵值（记录 id 是 UUID）。 */
const CREATE='__create__';

/**
 * 一行可就地编辑的字段。
 * @param document 宿主 document
 * @param label     显示的标签（如「负责人」）
 * @param value     当前值（提交时回传）
 * @param display   当前值的显示文本（人话）
 * @param options   给了就是下拉（[[值, 显示], …]）；没给就是输入框
 * @param type      输入框类型：'text' | 'date' | 'textarea'（目标这类长文本用 textarea）
 * @param create    下拉里的「＋ 新建」建什么：{kind:'organization'|'person'}；不传就没有这个入口
 * @param onCommit  提交回调：(新值) => Promise；抛错则还原并提示
 * @param notify    失败提示
 * @param format    把提交后的原始值转成人话再显示（例如日期 `2026-12-01` → `12月1日 周二`）
 */
export function inlineField(document, {label, value = '', display, options = null, type = 'text', empty = '未设置', onCommit, notify = () => {}, format = null, create = null} = {}) {
  const row = document.createElement('div');
  row.className = 'inlinefield';
  row.dataset.inlineField = label;
  // 长文本那一行独占一行：值只显示一行，点了才展开成多行输入 —— 版面不被一整段目标撑开。
  if (type === 'textarea') row.dataset.wide = '1';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = label;
  // 值在这一次打开期间会变：改完再点开，下拉里显示的必须是**刚改成的那个值**，
  // 不是打开弹窗那一刻的旧值（否则第二次修改会以旧值为基准，等于把上一次改动吞掉）。
  let current = value ?? '';
  let text = display ?? (current === '' || current === null || current === undefined ? empty : String(current));
  // 下拉候选也留着：新建出来的记录追加到这里，再点开就在候选里（不用重开弹窗）。
  const list = options ? [...options] : null;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'inlinevalue';
  button.dataset.inlineEdit = '1';
  button.title = '点一下改';
  /** 用当前状态重画那一行（值本身是可点的文字，不留"编辑态"）。 */
  const paint = () => {
    button.textContent = text;
    button.dataset.empty = current === '' || current === null || current === undefined ? '1' : '';
    button.setAttribute('aria-label', label + '：' + text + '（点一下改）');
    row.replaceChildren(name, button);
    button.focus();
  };
  paint();

  /** 提交一次改动：成功就把新值显示出来；失败还原并如实说原因（不假装成功）。 */
  let committing = false;
  const commitValue = async (next, shownText) => {
    committing = true;
    try {
      await onCommit(next);
      current = next;
      text = shownText ?? (next === '' || next === null || next === undefined ? empty : String(next));
      paint();
      return true;
    } catch (error) {
      paint();
      notify(error.message, true);
      return false;
    } finally {
      committing = false;
    }
  };

  button.onclick = () => {
    if (row.querySelector('[data-inline-editing]')) return;   // 已经在编辑，别叠第二层
    // 写入路径：调用方注入的 batch 优先（项目详情由 v7-controller 传进来），
    // 没注入的嵌入方回退到编辑弹窗登记的那一条（editor.mjs referenceWriter）——
    // 两条都是**同一条** batch.apply，不另起一套；都拿不到就不显示新建入口（不给死按钮）。
    const writer = create ? (create.batch ? {batch: create.batch} : referenceWriter()) : null;
    const box = document.createElement('span');
    box.className = 'inlineeditor';
    box.dataset.inlineEditing = '1';
    if (list) {
      // 「＋ 新建」只在真有写入路径时出现：宁可少一个入口，也不给一个点了没反应的按钮（约束三）。
      // 文案与「编辑项目」里的按钮逐字一致；加号用登记在册的线性图标（V9：不许拿「＋」字符当图标）。
      const choices = writer ? [...list, [CREATE, '新建' + refNoun(create.kind)]] : list;
      box.innerHTML = selectHtml({name: 'inline-' + label, attribute: 'data-inline', value: String(current ?? ''), options: choices, placeholder: '未设置'});
      wireSelects(box, {document});
      const createOption = box.querySelector('[data-viselect-option="' + CREATE + '"]');
      if (createOption) createOption.insertAdjacentHTML('afterbegin', '<svg class="icon" aria-hidden="true"><use href="#i-plus"/></svg>');
      const input = box.querySelector('input');
      /** 选了「＋ 新建」：把这一格换成和编辑弹窗**同一套**输入行，建完自动选中。 */
      const openCreate = () => {
        const line = refCreateRow(document, {
          kind: create.kind,
          notify,
          batch: writer.batch,
          announce: false,
          onCancel: paint,
          onCreated: async (id, title) => {
            list.push([id, title]);   // 候选留在这一格里：不用重开弹窗也能再选到它
            if (await commitValue(id, title)) notify(createdNotice(refNoun(create.kind), title));
          },
        });
        box.replaceChildren(line);
        line.querySelector('input')?.focus();
      };
      input?.addEventListener('change', async () => {
        const next = input.value;
        if (next === CREATE) { openCreate(); return; }
        if (next === current) { paint(); return; }
        await commitValue(next, list.find(([key]) => String(key) === String(next))?.[1]);
      });
    } else {
      const input = type === 'textarea' ? document.createElement('textarea') : document.createElement('input');
      if (type === 'textarea') { input.rows = 3; input.dataset.inlineTextarea = '1'; } else input.type = type;
      input.className = 'inlineinput';
      input.value = current ?? '';
      input.setAttribute('aria-label', label);
      box.append(input);
      const finish = async () => {
        const next = input.value;
        if (next === current) { paint(); return; }
        await commitValue(next, next === '' ? empty : (format ? format(next) : next));
      };
      input.addEventListener('change', finish);
      input.addEventListener('keydown', event => {
        // 多行文本里回车是换行；单行才是提交。Escape 一律还原（03 §就地编辑：退出即还原）。
        if (type !== 'textarea' && event.key === 'Enter') { event.preventDefault(); void finish(); }
        if (event.key === 'Escape') { event.preventDefault(); paint(); }
      });
    }
    row.replaceChildren(name, box);
    box.querySelector('input,textarea')?.focus();
    // 点开之后要能反悔：失焦即还原（没改动就什么都不发生）。
    // 正在提交时不还原 —— 否则会把已经写进去的新值先抹掉再画回来（闪一下，还把焦点抢回来）。
    const focusable = box.querySelector('input,textarea');
    focusable?.addEventListener('blur', () => {
      setTimeout(() => { if (!committing && row.querySelector('[data-inline-editing]')) paint(); }, 160);
    });
  };
  return row;
}

/** 把若干 inlineField 挂进一个容器（保持顺序）。 */
export function appendInlineFields(container, fields) {
  for (const field of fields) if (field) container.append(field);
  return container;
}
