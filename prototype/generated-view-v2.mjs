/** 生成视图（view v1）的前端渲染器 · 18-生成视图规范 §3–§6 · 27-开发方案 G1–G3。
 *
 *  只做三件事：把服务端返回的 view 画出来（4 模板 + 出处条 + 四态 + stale）、
 *  把用户动作变成两个受控调用（view_preview / view_save）、失败时给一句人话和一个下一步。
 *
 *  边界：
 *   - 不生成、不推断、不补数：所有值都来自 view.content；缺字段一律写「未记录」，不猜；
 *   - 不直连模型、不直接写库：保存只发 view_save，由服务端出 draft，再回到既有收件箱确认；
 *   - 不用 innerHTML 拼数据：整棵树用 DOM API + textContent 建，杜绝注入；
 *   - 不新增页面/一级入口：只作为项目详情、任务详情、知识页里的一个区块。
 */
import {downloadText} from './download.mjs';

export const TEMPLATES = ['risk-matrix', 'timeline', 'compare-table', 'blocker'];
export const TEMPLATE_LABELS = {'risk-matrix': '风险与证据', timeline: '时间线', 'compare-table': '材料对比', blocker: '阻塞说明'};
/** v1 只允许这三个动作（18 §3.2）。其他动作不渲染，不猜。 */
export const VIEW_ACTIONS = ['open-subject', 'save-as-judgment', 'save-as-brief'];
const SAVE_AS = {'save-as-judgment': 'judgment', 'save-as-brief': 'brief'};

const KIND_LABELS = {project: '项目', task: '任务', artifact: '材料', topic: '议题', judgment: '判断', deliverable: '交付项', person: '联系人', organization: '组织', event: '日程', message: '消息', file: '文件', audio: '音频', web: '网页', note: '笔记'};
const TIMELINE_STATES = {done: '已完成', waiting: '等待中', upcoming: '未开始', overdue: '已逾期'};
const CHAIN_STATES = {blocked: '受阻', waiting: '等待', done: '已完成', open: '未开始'};
const COMPARE_STATES = {same: '一致', diff: '分歧', missing: '未记录', unrated: '未比对'};

const el = (document, tag, className, text) => {
 const node = document.createElement(tag);
 if (className) node.className = className;
 if (text !== undefined && text !== null && text !== '') node.textContent = String(text);
 return node;
};
const add = (parent, ...children) => {
 for (const child of children) if (child) parent.append(child);
 return parent;
};
const num = value => typeof value === 'number' && Number.isFinite(value);
const text = value => (typeof value === 'string' ? value.trim() : '');
const kindLabel = kind => KIND_LABELS[kind] ?? '记录';
const toneFor = value => ({high: 'warn', medium: 'warn', low: 'quiet', done: 'ok', waiting: 'warn', upcooming: 'quiet', upcoming: 'quiet', overdue: 'danger', blocked: 'danger', open: 'quiet', diff: 'warn', missing: 'quiet', unrated: 'quiet', same: 'quiet'})[value] ?? 'quiet';

/** `id@revision` 里能打开的对象 id；文件路径（含点号/斜杠）不是记录 id，不假装能打开。 */
export function basisItemId(ref) {
 const head = String(ref ?? '').split('@')[0];
 return /^[A-Za-z0-9_-]+$/.test(head) ? head : null;
}

/** 时间只显示到分钟；解析不了就返回空串（由调用方写「未记录」），不显示 Invalid Date。 */
export function viewMomentText(value) {
 if (!value) return '';
 const date = new Date(value);
 if (Number.isNaN(date.getTime())) return '';
 const pad = number => String(number).padStart(2, '0');
 return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 出处条文案（18 §4 逐字口径）：AI 生成 · 依据 N 条 · 数据截至 YYYY-MM-DD HH:MM。 */
export function viewProvenance(view) {
 const origin = view?.origin === 'ai' ? 'AI 生成' : view?.origin === 'user' ? '由你生成' : '来源未记录';
 const count = Array.isArray(view?.basis) ? view.basis.length : 0;
 const at = viewMomentText(view?.generatedAt);
 return {origin, count, at, text: `${origin} · 依据 ${count} 条 · 数据截至 ${at || '时间未记录'}`};
}

/** 渲染前校验（18 §3.2 / G2）：未登记模板、越界引用一律拒绝渲染，不降级。 */
export function validateView(view) {
 const problems = [];
 if (!view || typeof view !== 'object' || Array.isArray(view)) return {ok: false, problems: ['没有拿到可渲染的视图数据']};
 if (!text(view.template)) problems.push('视图缺少模板标识，已拒绝渲染');
 else if (!TEMPLATES.includes(view.template)) problems.push(`模板「${view.template}」不在 v1 白名单里，已拒绝渲染`);
 if (view.kind !== undefined && view.kind !== 'view') problems.push('这不是一个视图对象，已拒绝渲染');
 if (view.dataRefs !== undefined) {
  if (!Array.isArray(view.dataRefs)) problems.push('数据引用格式不受支持，已拒绝渲染');
  else if (view.dataRefs.length > 50) problems.push('数据引用超过 50 条上限，已拒绝渲染');
 }
 if (view.basis !== undefined && !Array.isArray(view.basis)) problems.push('依据格式不受支持，已拒绝渲染');
 return {ok: problems.length === 0, problems};
}

/** 加载态：静态骨架 + 一行说明（不加动画；VI 宪章八：不做装饰性动效）。 */
export function renderLoading(document, {label = '正在生成分析…'} = {}) {
 const box = el(document, 'div', 'gv-state gv-loading');
 box.dataset.state = 'loading';
 box.setAttribute('role', 'status');
 box.setAttribute('aria-live', 'polite');
 box.append(el(document, 'p', 'gv-state-note', label));
 const skeleton = el(document, 'div', 'gv-skeleton');
 skeleton.setAttribute('aria-hidden', 'true');
 for (const width of ['100%', '72%', '88%']) {
  const line = el(document, 'span', 'gv-skel');
  line.style.width = width;
  skeleton.append(line);
 }
 box.append(skeleton);
 return box;
}

/** 非正常四态（空 / 失败 / 未接入 / 拒绝渲染）：都只有一句人话 + 一个可点下一步。 */
export function renderViewState(document, {state, title, note, actionLabel, onAction, extra} = {}) {
 const box = el(document, 'div', 'gv-state');
 box.dataset.state = state;
 if (state === 'error') box.setAttribute('role', 'alert');
 else box.setAttribute('role', 'status');
 box.append(el(document, 'strong', 'gv-state-title', title));
 if (note) box.append(el(document, 'p', 'gv-state-note', note));
 if (onAction && actionLabel) {
  const button = el(document, 'button', 'btn gv-state-action', actionLabel);
  button.type = 'button';
  button.onclick = () => onAction();
  box.append(button);
 }
 if (extra) box.append(extra);
 return box;
}

const basisLabel = basis => {
 const label = kindLabel(basis?.kind);
 const quote = text(basis?.quote);
 return quote ? `${label}：${quote}` : `${label}（未附摘录）`;
};

/** 出处条：AI 生成 · 依据 N 条 · 数据截至 …；依据默认收起，点开逐条列出。 */
function provenanceBar(document, view, {onOpenSubject, onOpenBasis} = {}) {
 const bar = el(document, 'div', 'gv-bar');
 const provenance = viewProvenance(view);
 const origin = el(document, 'span', 'gv-aichip', provenance.origin);
 bar.append(origin);
 if (provenance.count > 0) {
  const details = el(document, 'details', 'gv-basis');
  const summary = el(document, 'summary', 'gv-basissummary', `依据 ${provenance.count} 条`);
  details.append(summary);
  const list = el(document, 'ul', 'gv-basislist');
  for (const basis of view.basis) {
   const item = el(document, 'li', 'gv-basisitem');
   const id = basisItemId(basis?.ref);
   const line = el(document, 'span', 'gv-basisline', basisLabel(basis));
   if (id && onOpenBasis) {
    const button = el(document, 'button', 'gv-basisopen', line.textContent);
    button.type = 'button';
    button.onclick = () => onOpenBasis({...basis, id});
    item.append(button);
   } else item.append(line);
   list.append(item);
  }
  details.append(list);
  bar.append(details);
 } else {
  const missing = el(document, 'span', 'gv-basismissing', '依据 0 条');
  bar.append(missing);
 }
 bar.append(el(document, 'span', 'gv-asof', `数据截至 ${provenance.at || '时间未记录'}`));
 return bar;
}

function chipWithTone(document, value, label) {
 const chip = el(document, 'span', 'gv-chip', label ?? value ?? '未记录');
 chip.dataset.tone = toneFor(value);
 return chip;
}

function noteLine(document, value) {
 const line = text(value);
 return line ? el(document, 'span', 'gv-note', line) : null;
}

function emptyBody(document, template, options) {
 const copy = {
  'risk-matrix': {title: '还没有可分析的风险依据', note: '风险要落到真实记录上才算数。这个项目现在没有可用的任务、交付项或判断：先补材料或建一条判断，再回来生成。'},
  timeline: {title: '还没有可排到时间线上的记录', note: '时间线只排列真实的任务、交付项与判断。它们都还没有可用日期：补上日期或判断，再回来生成。'},
  'compare-table': {title: '至少要 2 条判断或材料才能对比', note: '当前可对比的记录不足。先在研究议题里建判断，或到文件与资料里补材料。'},
  blocker: {title: '还没有记录卡点', note: '这条任务没有填写等待原因、在等谁和下一步；先在任务详情里补上「等待原因」，再生成阻塞说明。'},
 }[template];
 const action = options?.emptyActions?.[template];
 return renderViewState(document, {state: 'empty', title: copy.title, note: copy.note, actionLabel: action?.label, onAction: action?.run});
}

/* ── 4 模板 ─────────────────────────────────────────────────────────────── */
function riskMatrix(document, view, content, options) {
 const rows = Array.isArray(content?.rows) ? content.rows : [];
 if (!rows.length) return {element: emptyBody(document, 'risk-matrix', options), empty: true};
 const declared = Array.isArray(content.columns) && content.columns.length
  ? content.columns.filter(column => column && (['risk', 'evidence', 'basis'].includes(column.id) || rows.some(row => row?.[column.id] !== undefined)))
  : [{id: 'risk', label: '风险'}, {id: 'evidence', label: '证据强度'}, {id: 'basis', label: '依据'}];
 const wrap = el(document, 'div', 'gv-tablewrap');
 const table = el(document, 'table', 'gv-table');
 const caption = el(document, 'caption', 'gv-caption', '风险按证据强度排列；每个值都来自项目里的真实记录');
 table.append(caption);
 const head = el(document, 'thead');
 const headRow = el(document, 'tr');
 headRow.append(el(document, 'th', 'gv-th', '记录'));
 for (const column of declared) headRow.append(el(document, 'th', 'gv-th', column.label ?? column.id));
 head.append(headRow);
 table.append(head);
 const body = el(document, 'tbody');
 for (const row of rows) {
  const tr = el(document, 'tr');
  const name = el(document, 'th', 'gv-th gv-rowhead');
  name.scope = 'row';
  name.append(el(document, 'span', 'gv-rowtitle', row?.title ?? '未命名记录'));
  const kind = el(document, 'span', 'gv-kind', kindLabel(row?.kind));
  name.append(kind);
  tr.append(name);
  for (const column of declared) {
   const td = el(document, 'td', 'gv-td');
   if (column.id === 'risk') {
    td.append(chipWithTone(document, row?.risk, row?.riskLabel ?? row?.risk ?? '未记录'));
    const reason = noteLine(document, row?.reason);
    if (reason) td.append(reason);
   } else if (column.id === 'evidence') {
    const bits = [row?.evidenceLabel ?? '未记录'];
    if (num(row?.evidenceCount)) bits.push(`${row.evidenceCount} 条依据`);
    if (num(row?.verifiedCount)) bits.push(`已核对 ${row.verifiedCount} 条`);
    td.append(el(document, 'span', 'gv-celltext', bits.join(' · ')));
    const reason = noteLine(document, row?.reason);
    if (reason) td.append(reason);
   } else if (column.id === 'basis') {
    const refs = Array.isArray(row?.refs) ? row.refs : [];
    td.append(el(document, 'span', 'gv-celltext', refs.length ? `${refs.length} 条依据` : '未记录'));
   } else {
    const value = row?.[column.id];
    td.append(el(document, 'span', 'gv-celltext', value === undefined || value === null || value === '' ? '未记录' : String(value)));
   }
   tr.append(td);
  }
  body.append(tr);
 }
 table.append(body);
 wrap.append(table);
 const holder = el(document, 'div', 'gv-template');
 holder.append(wrap);
 if (content?.counts && [content.counts.high, content.counts.medium, content.counts.low, content.counts.total].some(num)) {
  const counts = el(document, 'p', 'gv-metrics');
  const pairs = [['高', content.counts.high], ['中', content.counts.medium], ['低', content.counts.low], ['共', content.counts.total]];
  for (const [label, value] of pairs) if (num(value)) {
   const piece = el(document, 'span');
   piece.append(el(document, 'b', null, String(value)), el(document, 'span', null, ` 项${label === '共' ? '风险' : label}`));
   counts.append(piece);
  }
  holder.append(counts);
 }
 return {element: holder, empty: false};
}

function timeline(document, view, content, options) {
 const items = Array.isArray(content?.items) ? content.items : [];
 if (!items.length) return {element: emptyBody(document, 'timeline', options), empty: true};
 const holder = el(document, 'div', 'gv-template');
 if (content?.range?.from || content?.range?.to) {
  holder.append(el(document, 'p', 'gv-metrics', `范围 ${content.range.from ?? '未记录'} → ${content.range.to ?? '未记录'}`));
 }
 const wrap = el(document, 'div', 'gv-timelinewrap');
 const list = el(document, 'ol', 'gv-timeline');
 for (const item of items) {
  const row = el(document, 'li', 'gv-timelineitem');
  row.dataset.state = text(item?.state) || 'open';
  row.append(el(document, 'time', 'gv-timelinedate', item?.at ?? '时间未记录'));
  row.append(el(document, 'strong', 'gv-timelinetitle', item?.title ?? '未命名记录'));
  row.append(chipWithTone(document, item?.state, item?.stateLabel ?? TIMELINE_STATES[item?.state] ?? '状态未记录'));
  if (item?.waitingOn?.title) row.append(el(document, 'span', 'gv-note', `在等：${item.waitingOn.title}`));
  const reason = noteLine(document, item?.reason);
  if (reason) row.append(reason);
  list.append(row);
 }
 wrap.append(list);
 holder.append(wrap);
 return {element: holder, empty: false};
}

function compareTable(document, view, content, options) {
 const sources = Array.isArray(content?.sources) ? content.sources : [];
 const rows = Array.isArray(content?.matrix) ? content.matrix : [];
 if (sources.length < 2 || !rows.length) return {element: emptyBody(document, 'compare-table', options), empty: true};
 const holder = el(document, 'div', 'gv-template');
 const wrap = el(document, 'div', 'gv-tablewrap');
 const table = el(document, 'table', 'gv-table');
 table.append(el(document, 'caption', 'gv-caption', `并排对比 ${sources.length} 条记录；「分歧」表示两侧说法不一致`));
 const head = el(document, 'thead');
 const headRow = el(document, 'tr');
 headRow.append(el(document, 'th', 'gv-th', '维度'));
 for (const source of sources) {
  const th = el(document, 'th', 'gv-th');
  th.append(el(document, 'span', 'gv-rowtitle', source?.title ?? '未命名记录'));
  th.append(el(document, 'span', 'gv-kind', kindLabel(source?.kind)));
  headRow.append(th);
 }
 head.append(headRow);
 table.append(head);
 const body = el(document, 'tbody');
 for (const row of rows) {
  const tr = el(document, 'tr');
  const th = el(document, 'th', 'gv-th gv-rowhead', row?.label ?? row?.id ?? '未命名维度');
  th.scope = 'row';
  tr.append(th);
  const cells = Array.isArray(row?.cells) ? row.cells : [];
  for (let index = 0; index < sources.length; index += 1) {
   const cell = cells[index];
   const td = el(document, 'td', 'gv-td');
   if (!cell || cell.value === null || cell.value === undefined || cell.value === '') {
    td.append(el(document, 'span', 'gv-celltext gv-missing', '未记录'));
   } else {
    td.append(el(document, 'span', 'gv-celltext', String(cell.value)));
   }
   if (cell?.status && COMPARE_STATES[cell.status]) td.append(chipWithTone(document, cell.status, COMPARE_STATES[cell.status]));
   tr.append(td);
  }
  body.append(tr);
 }
 table.append(body);
 wrap.append(table);
 holder.append(wrap);
 const agreement = content?.agreement;
 if (agreement) {
  const parts = [];
  if (num(agreement.same)) parts.push(`一致 ${agreement.same} 处`);
  if (num(agreement.diff)) parts.push(`分歧 ${agreement.diff} 处`);
  if (num(agreement.missing)) parts.push(`未记录 ${agreement.missing} 处`);
  if (num(agreement.unrated)) parts.push(`未比对 ${agreement.unrated} 处`);
  if (parts.length) holder.append(el(document, 'p', 'gv-metrics', parts.join(' · ')));
 }
 return {element: holder, empty: false};
}

function blocker(document, view, content, options) {
 const task = content?.task ?? null;
 const chain = Array.isArray(content?.chain) ? content.chain : [];
 const waitingOn = Array.isArray(content?.waitingOn) ? content.waitingOn : [];
 const nextSteps = (Array.isArray(content?.nextSteps) ? content.nextSteps : []).slice(0, 3);
 const blockedReason = text(task?.blockedReason) || text(content?.blockedReason);
 if (!chain.length && !waitingOn.length && !nextSteps.length && !blockedReason) {
  return {element: emptyBody(document, 'blocker', options), empty: true};
 }
 const holder = el(document, 'div', 'gv-template');
 const chainBox = el(document, 'div', 'gv-chain');
 const steps = [
  {label: '卡在哪', value: task?.statusLabel ?? '状态未记录', detail: blockedReason || '原因未记录'},
  {label: '在等谁', value: waitingOn.length ? waitingOn.map(item => item?.title).filter(Boolean).join('、') : '没有记录在等的对象', detail: task?.dueDate ? `任务截止 ${task.dueDate}` : '截止日期未记录'},
  {label: '下一步', value: nextSteps[0]?.label ?? '没有记录下一步', detail: nextSteps[0]?.reason ?? '下一步未记录'},
 ];
 for (const step of steps) {
  const box = el(document, 'div', 'gv-chainstep');
  box.append(el(document, 'small', null, step.label), el(document, 'strong', null, step.value), el(document, 'p', null, step.detail));
  chainBox.append(box);
 }
 holder.append(chainBox);
 if (chain.length) {
  const list = el(document, 'ol', 'gv-chainlist');
  for (const item of chain) {
   const row = el(document, 'li', 'gv-chainitem');
   row.append(chipWithTone(document, item?.state, item?.stateLabel ?? CHAIN_STATES[item?.state] ?? '状态未记录'));
   row.append(el(document, 'span', 'gv-chaintitle', item?.title ?? '未命名记录'));
   const reason = noteLine(document, item?.reason);
   if (reason) row.append(reason);
   list.append(row);
  }
  holder.append(list);
 }
 if (nextSteps.length > 1) {
  const list = el(document, 'ol', 'gv-steplist');
  for (const step of nextSteps.slice(1)) {
   const row = el(document, 'li', 'gv-step');
   row.append(el(document, 'b', null, step?.label ?? '未命名下一步'));
   if (step?.reason) row.append(el(document, 'span', 'gv-note', step.reason));
   list.append(row);
  }
  holder.append(list);
 }
 return {element: holder, empty: false};
}


/* ── 静默后台生成（A 方案：不跳转对话） ─────────────────────────────── */
function assistantBackground(prompt, workspaceId) {
 return new Promise((resolve, reject) => {
  const requestId = 'gv-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  let timer;
  const cleanup = () => {
   window.removeEventListener('message', onMessage);
   clearTimeout(timer);
  };
  const onMessage = event => {
   if (event.origin !== location.origin) return;
   const data = event.data;
   if (!data || data.type !== 'workstation:generate-ack' || data.requestId !== requestId) return;
   cleanup();
   if (data.ok) resolve(data);
   else reject(Error(data.error || '后台任务没有被接受'));
  };
  window.addEventListener('message', onMessage);
  try {
   window.parent.postMessage({type: 'workstation:generate', requestId, prompt, workspaceId}, location.origin);
  } catch (error) { cleanup(); reject(error); return; }
  timer = setTimeout(() => { cleanup(); reject(Error('内嵌窗口没有响应；可以到 DSH 对话里粘贴提示词重试')); }, 15000);
 });
}

/** 轮询收件箱，等后台助手把新视图草稿写进来；只认本次请求之后出现、对象/模板匹配的草稿。 */
async function waitForAssistantDraft(send, {baseline, subjectId, template}) {
 for (let i = 0; i < 90; i += 1) {
  await new Promise(resolve => setTimeout(resolve, 3000));
  const inbox = await send('inbox', {status: 'draft', limit: 50}).catch(() => ({items: []}));
  const hit = (inbox.items || []).find(batch => {
   if (baseline.has(batch.id)) return false;
   return (batch.changes || []).some(change => change.data?.template === template && change.data?.subject?.id === subjectId);
  });
  if (hit) return hit;
 }
 throw Error('后台生成超时；结果可能还在路上，稍后再试');
}


/** 生成结果的就地编辑：只改 AI 解读文字，引用关系保持不变。 */
function analysisEditor(document, view, {onSave, onCancel}) {
 const form = el(document, 'form', 'gv-editor');
 const summary = el(document, 'textarea', 'gv-editorfield');
 summary.value = view.analysis?.summary ?? '';
 summary.rows = 4;
 summary.setAttribute('aria-label', '结论');
 const summaryLabel = el(document, 'label', 'gv-editorlabel', '结论');
 summaryLabel.append(summary);
 form.append(summaryLabel);
 const findingBox = el(document, 'div', 'gv-editorfindings');
 (view.analysis?.findings ?? []).forEach((finding, index) => {
  const label = el(document, 'label', 'gv-editorlabel', '依据 ' + (index + 1) + ' · ' + finding.ref);
  const input = el(document, 'textarea', 'gv-editorfield');
  input.value = finding.text;
  input.rows = 2;
  input.dataset.ref = finding.ref;
  label.append(input);
  findingBox.append(label);
 });
 form.append(findingBox);
 const uncertainty = el(document, 'textarea', 'gv-editorfield');
 uncertainty.value = view.analysis?.uncertainty ?? '';
 uncertainty.rows = 2;
 const uncertaintyLabel = el(document, 'label', 'gv-editorlabel', '不确定性');
 uncertaintyLabel.append(uncertainty);
 form.append(uncertaintyLabel);
 const actions = el(document, 'div', 'gv-actions');
 const save = el(document, 'button', 'btn primary', '保存');
 save.type = 'submit';
 const cancel = el(document, 'button', 'btn', '取消');
 cancel.type = 'button';
 cancel.onclick = onCancel;
 actions.append(save, cancel);
 form.append(actions);
 form.onsubmit = async event => {
  event.preventDefault();
  save.disabled = true;
  try {
   const findings = [...findingBox.querySelectorAll('textarea')].map(input => ({ref: input.dataset.ref, text: input.value.trim()})).filter(finding => finding.text);
   await onSave({summary: summary.value.trim(), findings, uncertainty: uncertainty.value.trim()});
  } finally { save.disabled = false; }
 };
 return form;
}

/** AI 解读（spec/18 v1.1）：模型写的 summary / findings / uncertainty，findings 必须引用 dataRefs。 */
function analysisBlock(document, view, options) {
 const analysis = view.analysis;
 if (!analysis || (!analysis.summary && !(analysis.findings ?? []).length)) return null;
 const box = el(document, 'section', 'gv-analysis');
 box.setAttribute('aria-label', 'AI 解读');
 const head = el(document, 'div', 'gv-analysishead');
 head.append(el(document, 'strong', 'gv-analysistitle', 'AI 解读'));
 if (view.origin === 'ai') head.append(el(document, 'span', 'gv-chip', '模型生成'));
 box.append(head);
 if (analysis.summary) box.append(el(document, 'p', 'gv-analysissummary', analysis.summary));
 if ((analysis.findings ?? []).length) {
  const list = el(document, 'ul', 'gv-findings');
  for (const finding of analysis.findings) {
   const item = el(document, 'li', 'gv-finding');
   item.append(el(document, 'span', 'gv-findingtext', finding.text));
   const ref = el(document, 'span', 'gv-findingref', finding.ref);
   ref.title = '依据对象：' + finding.ref;
   item.append(ref);
   list.append(item);
  }
  box.append(list);
 }
 if (analysis.uncertainty) box.append(el(document, 'p', 'gv-analysisuncertainty', '不确定性：' + analysis.uncertainty));
 return box;
}

const TEMPLATE_RENDERERS = {'risk-matrix': riskMatrix, timeline, 'compare-table': compareTable, blocker};

/** 渲染一个 view。返回 {element, empty, refused, template}；不抛错（坏数据走拒绝渲染态）。 */
export function renderView(document, view, options = {}) {
 const root = el(document, 'div', 'gv-view');
 const valid = validateView(view);
 if (!valid.ok) {
  root.append(renderViewState(document, {
   state: 'refused',
   title: '这张视图没有通过渲染前检查',
   note: valid.problems[0],
   actionLabel: options.onRegenerate ? '重新生成' : undefined,
   onAction: options.onRegenerate,
  }));
  return {element: root, refused: true, empty: false, template: null};
 }
 const provenance = viewProvenance(view);
 const head = el(document, 'div', 'gv-viewhead');
 if (text(view.title)) head.append(el(document, 'strong', 'gv-viewtitle', view.title));
 const templateChip = el(document, 'span', 'gv-chip', TEMPLATE_LABELS[view.template]);
 templateChip.dataset.tone = 'quiet';
 head.append(templateChip);
 root.append(head);
 root.append(provenanceBar(document, view, options));
 const ai = analysisBlock(document, view, options);
 if (ai) root.append(ai);
 if (view.state === 'stale') {
  const stale = el(document, 'div', 'gv-stale');
  stale.setAttribute('role', 'status');
  stale.append(el(document, 'strong', null, '依据已变，需复核'), el(document, 'span', null, '生成之后，依据对象被改过；重新生成才会用最新内容。'));
  if (options.onRegenerate) {
   const again = el(document, 'button', 'btn gv-staleaction', '重新生成');
   again.type = 'button';
   again.onclick = () => options.onRegenerate();
   stale.append(again);
  }
  root.append(stale);
 }
 const built = (TEMPLATE_RENDERERS[view.template] ?? (() => ({element: emptyBody(document, view.template, options), empty: true})))(document, view, view.content ?? view.templateData ?? {}, options);
 root.append(built.element);
 const hasBasis = Array.isArray(view.basis) && view.basis.length > 0;
 const actions = el(document, 'div', 'gv-actions');
 const requested = Array.isArray(view.actions) && view.actions.length ? view.actions : VIEW_ACTIONS;
 const allowed = requested.filter(action => VIEW_ACTIONS.includes(action));
 let actionCount = 0;
 const addAction = (label, run) => {
  const button = el(document, 'button', 'btn gv-action', label);
  button.type = 'button';
  button.onclick = run;
  actions.append(button);
  actionCount += 1;
  return button;
 };
 if (allowed.includes('open-subject') && options.onOpenSubject && view.subject?.id) {
  addAction('打开原对象', () => options.onOpenSubject(view.subject.id));
 }
 if (hasBasis && !built.empty && options.onExport) {
  addAction('导出文档', () => options.onExport(view));
 }
 if (view.analysis && typeof options.onEditAnalysis === 'function') {
  addAction('编辑解读', () => options.onEditAnalysis(view));
 }
 if (hasBasis && !built.empty) {
  for (const action of ['save-as-judgment', 'save-as-brief']) {
   if (!allowed.includes(action) || !options.onSave) continue;
   const label = action === 'save-as-judgment' ? '存为判断' : '存为简报';
   const button = el(document, 'button', 'btn gv-action', label);
   button.type = 'button';
   actions.append(button);
   actionCount += 1;
   button.onclick = async () => {
    if (button.disabled) return;
    button.disabled = true;
    try {
     await options.onSave(view, SAVE_AS[action]);
    } catch (error) {
     const message = error?.message || '暂时没能保存，请稍后再试';
     let note = root.querySelector('[data-gv-saveerror]');
     if (!note) {
      note = el(document, 'p', 'gv-note gv-saveerror');
      note.dataset.gvSaveerror = '1';
      actions.after(note);
     }
     note.textContent = `没能保存：${message}。可以再点一次。`;
    } finally {
     if (button.isConnected) button.disabled = false;
    }
   };
  }
 }
 if (hasBasis && options.onSave && actionCount === 0) {
  root.append(renderViewState(document, {state: 'error', title: '这张视图没有可保存的动作', note: '服务端没有给出允许的动作，或当前对象不允许保存。'}));
 }
 if (actionCount) root.append(actions);
 else if (!hasBasis) root.append(renderViewState(document, {state: 'empty', title: '这张视图没有依据，不能保存', note: '没有依据的视图只是一次性预览；补上依据后重新生成。'}));
 if (options.onClose) {
  const close = el(document, 'button', 'gv-closepreview', '收起预览');
  close.type = 'button';
  close.onclick = () => options.onClose();
  root.append(close);
 }
 return {element: root, refused: false, empty: built.empty, template: view.template};
}

/* ── 区块 + 两个受控调用 ─────────────────────────────────────────────── */
function classifyPreviewError(error) {
 const code = String(error?.code ?? '');
 const message = text(error?.message) || '生成分析时出错了，请稍后再试';
 if (code === 'UNAVAILABLE') return {state: 'empty', title: '现在还生成不了这张视图', note: message, retry: true};
 if (code === 'INVALID') return {state: 'error', title: '这次生成没有通过检查', note: message, retry: true};
 if (code === 'REFERENCE') return {state: 'error', title: '依据里的对象已被删除或归档', note: message, retry: true};
 if (code === 'UNKNOWN_ACTION' || code === 'NOT_IMPLEMENTED' || /未知.*动作|不支持该动作|未实现|not implemented/i.test(message)) {
  return {state: 'unwired', title: '生成视图还没接上', note: '界面已经就绪，但当前版本还没有接通生成服务。接上后点「重试」即可。', retry: true};
 }
 return {state: 'error', title: '生成分析时出错了', note: message, retry: true};
}

/**
 * 在页面里挂一个「生成视图」区块。
 * options: {notify, openBatch(id), openBasis(basis)}
 * block(config): {subjectId, heading, summary, templates:[{id,label,params,emptyAction}], onOpenSubject(id), emptyActions:{templateId:{label,run}}}
 */
export function createGeneratedView(document, send, options = {}) {
 const notify = options.notify ?? (() => {});
 if (typeof send !== 'function') throw Error('生成视图需要 send 能力');

 async function save(view, as) {
  const result = await send('view_save', {view, as});
  const batch = result?.batch ?? null;
  const what = as === 'judgment' ? '判断' : as === 'brief' ? '简报' : '视图';
  if (batch?.id) {
   notify(`已生成待确认的${what}；确认后才会生效，可以撤销`);
   if (options.openBatch) await options.openBatch(batch.id);
  } else {
   notify(`已生成待确认的${what}，请到收件箱确认后生效`);
  }
  return result;
 }

 /** 导出文档：留档另生成 Markdown（18 §6），不落库、不改视图。 */
 async function exportDoc(view) {
  const result = await send('view_export', {view});
  if (!result || typeof result.markdown !== 'string') throw Error('导出内容为空，请重新生成后再试');
  downloadText(document, result.filename || '分析视图.md', result.markdown);
  notify('已下载分析文档；视图定义仍保留，可重开');
  return result;
 }

 function block(config) {
  const subjectId = config?.subjectId ?? null;
  const templates = Array.isArray(config?.templates) ? config.templates : [];
  const section = el(document, 'section', 'gv-block');
  section.dataset.gvBlock = '1';
  section.setAttribute('aria-label', config?.heading ?? '分析视图');
  const head = el(document, 'div', 'gv-head');
  head.append(el(document, 'h3', 'gv-title', config?.heading ?? '分析视图'));
  if (config?.summary) head.append(el(document, 'p', 'gv-summary', config.summary));
  section.append(head);
  const picker = el(document, 'div', 'gv-generate');
  const preview = el(document, 'div', 'gv-preview');
  preview.hidden = true;
  preview.dataset.gvPreview = '1';
  preview.setAttribute('role', 'region');
  preview.setAttribute('aria-live', 'polite');
  const close = el(document, 'button', 'btn gv-collapse', '收起预览');
  close.type = 'button';
  close.hidden = true;
  let busy = false;
  const clear = () => {
   preview.replaceChildren();
   preview.hidden = true;
   close.hidden = true;
  };
  close.onclick = () => clear();

  const run = async (template) => {
   if (busy || !template?.id) return;
   busy = true;
   preview.hidden = false;
   close.hidden = false;
   preview.replaceChildren(renderLoading(document));
   for (const button of picker.querySelectorAll('button[data-gv-generate]')) button.disabled = true;
   picker.setAttribute('aria-busy', 'true');
   const params = typeof template.params === 'function' ? template.params() : template.params ?? {};
   try {
    const result = await send('view_preview', {template: template.id, ...(subjectId ? {subjectId} : {}), params: params ?? {}});
    if (!section.isConnected) return;
    const view = result?.view ?? result;
    const rendered = renderView(document, view, {
     onOpenSubject: config?.onOpenSubject,
     onOpenBasis: options.openBasis,
     onSave: save,
     onExport: exportDoc,
     onRegenerate: () => run(template),
     emptyActions: config?.emptyActions,
     onClose: clear,
    });
    preview.replaceChildren(rendered.element);
   } catch (error) {
    if (!section.isConnected) return;
    const classified = classifyPreviewError(error);
    preview.replaceChildren(renderViewState(document, {
     state: classified.state,
     title: classified.title,
     note: classified.note,
     actionLabel: classified.retry ? '重试' : undefined,
     onAction: () => run(template),
     extra: config?.emptyActions?.[template.id]
      ? (() => {
       const action = config.emptyActions[template.id];
       const button = el(document, 'button', 'btn gv-state-action', action.label);
       button.type = 'button';
       button.onclick = () => action.run();
       return button;
      })()
      : null,
    }));
   } finally {
    busy = false;
    picker.removeAttribute('aria-busy');
    for (const button of picker.querySelectorAll('button[data-gv-generate]')) if (button.isConnected) button.disabled = false;
   }
  };

  /** 重开一张已保存的视图：按定义重新计算，引用变化时显示 stale（18 §5/§6）。 */
  const openSaved = async (viewId) => {
   if (busy || !viewId) return;
   busy = true;
   preview.hidden = false;
   close.hidden = false;
   preview.replaceChildren(renderLoading(document, {label: '正在按当前数据重算…'}));
   try {
    const result = await send('view_preview', {viewId});
    if (!section.isConnected) return;
    const view = result?.view ?? result;
    const rendered = renderView(document, view, {
     onOpenSubject: config?.onOpenSubject,
     onOpenBasis: options.openBasis,
     onSave: save,
     onExport: exportDoc,
     onRegenerate: () => openSaved(viewId),
     emptyActions: config?.emptyActions,
     onClose: clear,
    });
    preview.replaceChildren(rendered.element);
   } catch (error) {
    if (!section.isConnected) return;
    const classified = classifyPreviewError(error);
    preview.replaceChildren(renderViewState(document, {
     state: classified.state,
     title: classified.title,
     note: classified.note,
     actionLabel: classified.retry ? '重试' : undefined,
     onAction: () => openSaved(viewId),
    }));
   } finally {
    busy = false;
   }
  };

  for (const template of templates) {
   const button = el(document, 'button', 'btn gv-generatebutton', template.label ?? `生成${TEMPLATE_LABELS[template.id] ?? '分析'}`);
   button.type = 'button';
   button.dataset.gvGenerate = template.id;
   button.onclick = () => run(template);
   picker.append(button);
  }
  if (typeof options.askAssistant === 'function' && subjectId) {
   const ask = el(document, 'button', 'btn gv-askassistant', '让 DSH 助手生成');
   ask.type = 'button';
   ask.title = '把任务交给 DSH 助手：当前模型会读取真实数据、写出 AI 解读并保存';
   ask.onclick = async () => {
    const template = templates[0];
    const params = typeof template?.params === 'function' ? template.params() : template?.params ?? {};
    const label = TEMPLATE_LABELS[template?.id] ?? '分析';
    const subjectTitle = config?.subjectTitle ?? '这个对象';
    const subjectKind = config?.subjectKind ?? '对象';
    const prompt = `请在工作台里为${subjectKind}「${subjectTitle}」（id: ${subjectId ?? '未知'}）生成「${label}」视图。步骤：\n1) 调用 workstation 工具，action=view_preview，template=${template?.id ?? ''}${subjectId ? `，subjectId=${subjectId}` : ''}，params=${JSON.stringify(params)}，先读取真实数据（不要编造）。\n2) 只依据返回的 dataRefs 与 basis 写 AI 解读：summary≤300字；findings 3–6 条，每条 ref 必须来自返回的 dataRefs，text≤200字；uncertainty≤200字。\n3) 调用 workstation 工具，action=view_save，template=${template?.id ?? ''}${subjectId ? `，subjectId=${subjectId}` : ''}，analysis={summary,findings,uncertainty} 保存；保存后我会直接看到结果，不需要再去收件箱确认。`;
    const embedded = window.parent && window.parent !== window && typeof options.askAssistant === 'function';
    if (!embedded) {
     // 非内嵌窗口：不跳页、不关弹窗，就在当前详情里给出可复制的提示词。
     ask.disabled = true;
     preview.hidden = false;
     close.hidden = false;
     const block = el(document, 'div', 'gv-block gv-askprompt');
     const title = el(document, 'h3', '', '交给 DSH 助手');
     const hint = el(document, 'p', 'notice', '当前不在 DSH 内嵌窗口，无法在后台直接生成；把下面这段提示词复制到对话里发送即可。');
     const box = el(document, 'pre', 'gv-prompt', prompt);
     const copy = el(document, 'button', 'btn', '复制提示词');
     copy.type = 'button';
     copy.onclick = () => {
      try { navigator.clipboard?.writeText(prompt); copy.textContent = '已复制'; } catch { copy.textContent = '复制失败，请手动选中'; }
     };
     block.append(title, hint, box, copy);
     preview.replaceChildren(block);
     return;
    }
    ask.disabled = true;
    preview.hidden = false;
    close.hidden = false;
    preview.replaceChildren(renderLoading(document, {label: '正在后台生成，先不用离开这一页…'}));
    try {
     const baseline = new Set(((await send('inbox', {status: 'draft', limit: 50})).items || []).map(batch => batch.id));
     await assistantBackground(prompt, globalThis.__dshWorkbenchRoot?.id);
     const hit = await waitForAssistantDraft(send, {baseline, subjectId, template: template?.id});
     const view = (hit.changes || []).find(change => change.data?.template === template?.id)?.data;
     if (!view) throw Error('后台已经生成内容，但没取到视图；可以再点一次');
     // 用户 2026-10-18：AI 结果直接出现在这里，不进收件箱；后续可编辑。
     const committed = await send('commit', {id: hit.id, revision: hit.revision, key: 'gv-' + Date.now()});
     const saved = (committed.after || []).find(item => item.kind === 'view') || {};
     const viewId = saved.id;
     let revision = saved.revision;
     if (!viewId) throw Error('生成结果没有保存成功；可以再点一次');
     const renderOptions = {
      onOpenSubject: config?.onOpenSubject,
      onOpenBasis: options.openBasis,
      onSave: save,
      onExport: exportDoc,
      onRegenerate: () => ask.click(),
      emptyActions: config?.emptyActions,
      onClose: clear,
     };
     const renderSaved = async current => {
      const full = (await send('view_preview', {viewId})).view;
      const rendered = renderView(document, full, {
       ...renderOptions,
       onEditAnalysis: () => {
        preview.replaceChildren(analysisEditor(document, full, {
         onCancel: () => renderSaved(current),
         onSave: async analysis => {
          const updated = await send('view_analysis_update', {viewId, revision, analysis});
          revision = updated.item?.revision ?? revision;
          notify('AI 解读已更新');
          await renderSaved(updated.item ?? full);
         },
        }));
       },
      });
      preview.replaceChildren(rendered.element);
     };
     await renderSaved(view);
     notify('已生成并保存；可以直接编辑解读');
    } catch (error) {
     preview.replaceChildren(renderViewState(document, {state: 'error', title: '后台生成没有完成', note: error?.message || '可以再点一次', actionLabel: '重试', onAction: () => ask.click()}));
    } finally {
     ask.disabled = false;
    }
   };
   picker.append(ask);
  }
  picker.append(close);
  section.append(picker, preview);
  return {
   element: section,
   generate: templateId => run(templates.find(template => template.id === templateId)),
   openSaved,
   clear,
  };
 }

 return {block, save, renderView: (view, renderOptions) => renderView(document, view, renderOptions)};
}
