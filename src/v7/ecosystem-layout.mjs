/** 关联空间 · 结构态纯函数层（批次 A2）
 *
 *  定位：这里只放**可单测的纯函数**——角色分组、原地展开、子卡排布、镜头适配、语义缩放、
 *  颜色形状映射、容量文案。不 import DOM、不 import 现有画布、不读写业务数据、不产生副作用。
 *  接线（space-view-v5.mjs / build-v7.mjs / CSS）由 Lead 负责；本模块只给算法与常量。
 *
 *  单一事实源（spec/54 §1.5）：
 *   · 角色名只在 `organization.defaultRole` 与 `project.participants[].role` 里；
 *     本模块只读不写，也不存第二份角色名。
 *   · 本模块不写死任何机构/项目数据；模板只是「建议顺序」，不限制用户自定角色。
 *
 *  默认 scope = 'all'（D8）。角色名可以是通用角色键（self/client/…），也可以是用户自由文本
 *  （中文、任意词）；通用键显示时查 ROLE_LABELS，自由文本原样显示、不翻译。
 *  显式不允许：hex 色值（只用已登记 --pal-* token）、DOM、往输入对象里写字段。
 */

/** 画布默认 scope：全部机构（D8）。 */
export const DEFAULT_SCOPE = 'all';
export const UNCLASSIFIED_LABEL = '未分类';
export const UNASSIGNED_LABEL = '未归属';

/** 通用 8 类 + 其他：键是稳定的角色标识，值是对用户显示的角色名。 */
export const ROLE_LABELS = Object.freeze({
  self: '主体',
  client: '客户',
  partner: '伙伴',
  supply: '供应',
  research: '研究政策',
  standard: '标准行业',
  capital: '资本渠道',
  competitor: '竞争替代',
  other: '其他',
});
/** 通用角色键，顺序即自定义模板顺序。 */
export const ROLE_KEYS = Object.freeze(['self', 'client', 'partner', 'supply', 'research', 'standard', 'capital', 'competitor', 'other']);

/** 项目角色模板：只是建议顺序 + 建议角色，不限制用户自定角色名（spec/54 §1.4）。 */
export const ROLE_TEMPLATES = Object.freeze({
  delivery: Object.freeze({ label: '客户交付', roles: Object.freeze(['self', 'client', 'partner', 'supply', 'standard', 'other']) }),
  ecosystem: Object.freeze({ label: '生态 / 战略', roles: Object.freeze(['self', 'research', 'supply', 'client', 'partner', 'standard', 'capital', 'other']) }),
  investment: Object.freeze({ label: '研判 / 投资', roles: Object.freeze(['self', 'supply', 'client', 'capital', 'research', 'competitor', 'other']) }),
  research: Object.freeze({ label: '研究议题', roles: Object.freeze(['self', 'research', 'partner', 'standard', 'capital', 'competitor', 'other']) }),
  custom: Object.freeze({ label: '自定义', roles: Object.freeze(['self', 'client', 'partner', 'supply', 'research', 'standard', 'capital', 'competitor', 'other']) }),
});

/** 已登记的 10 个分类色 token（spec/53 §2.1：颜色只从已登记调色板取，不写 hex）。 */
export const PALETTE_TOKENS = Object.freeze([
  '--pal-indigo',
  '--pal-teal',
  '--pal-cyan',
  '--pal-violet',
  '--pal-magenta',
  '--pal-pink',
  '--pal-orange',
  '--pal-slate',
  '--pal-gold',
  '--pal-lime',
]);
/** 形状只有 5 种（spec/52 §2.2）。 */
export const SHAPES = Object.freeze(['hexagon', 'diamond', 'square', 'circle', 'triangle']);
/** 未分类/未归属固定灰色 + 问号语义由调用方用文字/图标补；纯函数层不给「问号形状」。 */
export const UNCLASSIFIED_VISUAL = Object.freeze({ colorToken: '--pal-slate', shape: 'circle' });
export const UNASSIGNED_VISUAL = Object.freeze({ colorToken: '--pal-slate', shape: 'circle' });

/** 角色桶 / 分类建议上限；“超过”以 > 判定，正好 10 类不算超。 */
export const MAX_ROLE_BUCKETS = 10;
/** 单个角色桶里机构数量的建议上限；超过时由视图折叠/翻页，纯函数层不丢数据。 */
export const BUCKET_AGGREGATE_LIMIT = 20;
/** 语义缩放阈值，必须与 space-view-v5.mjs 的 nodeDetailAt（<0.6）与 showsEdgeLabels（>1.1）一致。 */
export const TIER_NAME_MAX = 0.6;
export const TIER_RELATION_MIN = 1.1;

const asArray = value => (Array.isArray(value) ? value : []);
const textOf = value => (typeof value === 'string' ? value.trim() : '');
const numOf = value => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
/** -0 归一成 +0（深比较/序列化都更干净）。 */
const clean = value => (value === 0 ? 0 : value);
const normalizeScope = scope => {
  if (typeof scope === 'string' && scope.trim().startsWith('project:')) {
    const projectId = scope.trim().slice('project:'.length).trim();
    if (projectId) return { kind: 'project', projectId, value: 'project:' + projectId };
  }
  return { kind: 'all', projectId: null, value: DEFAULT_SCOPE };
};
const nodeKind = node => (node && typeof node.kind === 'string' ? node.kind : '');

/** 角色显示名：通用键查表，自由文本原样返回（不翻译、不截断），空 = 未分类。 */
export function roleLabel(role) {
  const raw = textOf(role);
  if (!raw) return UNCLASSIFIED_LABEL;
  return ROLE_LABELS[raw] ?? raw;
}

/** 模板的建议角色顺序（返回副本：调用方可以排序，不会改到常量）。 */
export function templateRoles(templateKey) {
  const template = ROLE_TEMPLATES[templateKey] ?? ROLE_TEMPLATES.custom;
  return template.roles.slice();
}

/** 角色 → 模板里的位置。通用键与其中文标签都算同一个角色（只影响排序，不合并桶、不改显示）。 */
const canonicalRoleKey = role => {
  if (Object.prototype.hasOwnProperty.call(ROLE_LABELS, role)) return role;
  for (const key of ROLE_KEYS) if (ROLE_LABELS[key] === role) return key;
  return null;
};
const rolePosition = (role, templateRoleKeys) => {
  const key = canonicalRoleKey(role);
  if (!key) return -1;
  return templateRoleKeys.indexOf(key);
};

/** 机构全局默认角色：trim 后非空返回，否则 null = 未分类。 */
export function roleOfOrg(org) {
  const role = textOf(org?.defaultRole);
  return role || null;
}

/** 机构在该项目里的参与者角色：找不到条目或 role 为空都返回 null。 */
export function roleOfParticipant(project, organizationId) {
  const orgId = textOf(organizationId);
  if (!orgId) return null;
  for (const participant of asArray(project?.participants)) {
    if (textOf(participant?.organizationId) !== orgId) continue;
    return textOf(participant?.role) || null;
  }
  return null;
}

/** 项目「主责或参与」的机构 ID（去重；partnerId 是旧数据兼容字段，不算参与，见 childrenOf 注释）。 */
const projectOrgIds = project => {
  const ids = [];
  const owner = textOf(project?.organizationId);
  if (owner) ids.push(owner);
  for (const participant of asArray(project?.participants)) {
    const orgId = textOf(participant?.organizationId);
    if (orgId) ids.push(orgId);
  }
  return [...new Set(ids)];
};

/** 一组机构的「主责或参与」项目（按 nodes 输入顺序，去重）。 */
const projectIdsOfOrgs = (orgIds, projectList) => {
  const orgSet = new Set(orgIds);
  const ids = [];
  for (const project of projectList) {
    if (projectOrgIds(project).some(orgId => orgSet.has(orgId))) ids.push(project.id);
  }
  return ids;
};

/** 桶的计数：organizations = 桶内机构数；projects/tasks = 从这些机构沿结构下钻可达的数量。
 *  project scope 下 onlyProjectId 会把 projects 收窄到焦点项目，保证计数不越出当前 scope。 */
const countsOf = (orgIds, { projectList, taskList, onlyProjectId = null }) => {
  const projectIds = projectIdsOfOrgs(orgIds, projectList).filter(id => onlyProjectId === null || id === onlyProjectId);
  const projectSet = new Set(projectIds);
  return {
    organizations: orgIds.length,
    projects: projectIds.length,
    tasks: taskList.filter(task => projectSet.has(textOf(task.projectId))).length,
  };
};
const countsOfProjects = (projectIds, taskList) => {
  const projectSet = new Set(projectIds);
  return {
    organizations: 0,
    projects: projectIds.length,
    tasks: taskList.filter(task => projectSet.has(textOf(task.projectId))).length,
  };
};

/** 桶排序：模板里出现的通用角色按模板顺序在前；自定义/未知角色按首次出现顺序追加。
 *  未分类桶由调用方永远放最后（这里不生成它）。 */
const orderedRoleGroups = (groups, templateRoleKeys) => {
  const ranked = [];
  const appended = [];
  for (const group of groups.values()) {
    const position = rolePosition(group.role, templateRoleKeys);
    if (position >= 0) ranked.push({ group, position });
    else appended.push(group);
  }
  ranked.sort((left, right) => left.position - right.position || left.group.order - right.group.order);
  return [...ranked.map(item => item.group), ...appended];
};

/** 分类：把机构/项目/任务按「相对焦点的关系角色」分组（spec/54 §1、§2；JSON 可序列化）。
 *
 *  scope 'all'（默认，D8）：
 *   · 桶 = 各机构按 organization.defaultRole 分组（未分类桶永远最后）；
 *   · 项目不自己成桶，只在 counts 里计数；项目经单击机构后才展开（childrenOf）；
 *   · 另加「未归属」桶：没有 organizationId 也没有 partnerId 的项目（不猜归属）。
 *  scope 'project:<id>'：
 *   · 焦点 = 该项目；桶 = participants 按 role 分组，机构卡入桶；
 *   · 顺序按 project.roleTemplate 的模板顺序，自定义/未知角色稳定追加，未分类最后；
 *   · participants 为空 → buckets: []，调用方显示「这个项目还没有参与机构」。
 *
 *  counts 语义：organizations = 桶内机构数；projects/tasks = 从桶内机构沿结构下钻（当前 scope 内）的数量。
 *  未归属桶的 roleIds 是**项目 ID**（桶成员就是项目），counts.organizations = 0。
 *  不丢数据：超过 10 类也不合并、不丢角色名；是否折叠/聚合由视图层用 capacityReport 提示决定。
 */
export function classify({ nodes, scope } = {}) {
  const byId = new Map();
  for (const node of asArray(nodes)) {
    if (!node || typeof node.id !== 'string' || !node.id || byId.has(node.id)) continue;
    byId.set(node.id, node);
  }
  const all = [...byId.values()];
  const organizations = all.filter(node => nodeKind(node) === 'organization');
  const projects = all.filter(node => nodeKind(node) === 'project');
  const tasks = all.filter(node => nodeKind(node) === 'task');
  const normalized = normalizeScope(scope);

  if (normalized.kind === 'project') {
    const focus = byId.get(normalized.projectId);
    const focusProject = focus && nodeKind(focus) === 'project' ? focus : null;
    const orgIds = new Set(organizations.map(org => org.id));
    const groups = new Map();
    const unclassifiedIds = [];
    const groupedOrgIds = new Set();
    for (const participant of asArray(focusProject?.participants)) {
      const orgId = textOf(participant?.organizationId);
      // 画布上不画不存在的机构卡：participants 引用失效时不生成空桶（store 会拦引用，这里是防御）。
      if (!orgId || !orgIds.has(orgId) || groupedOrgIds.has(orgId)) continue;
      groupedOrgIds.add(orgId);
      const role = textOf(participant?.role) || null;
      if (role === null) {
        unclassifiedIds.push(orgId);
        continue;
      }
      if (!groups.has(role)) groups.set(role, { role, ids: [], order: groups.size });
      groups.get(role).ids.push(orgId);
    }
    const templateRoleKeys = templateRoles(focusProject?.roleTemplate);
    const buckets = orderedRoleGroups(groups, templateRoleKeys).map(group => ({
      key: group.role,
      label: roleLabel(group.role),
      kind: 'role',
      roleIds: group.ids.slice(),
      counts: countsOf(group.ids, { projectList: projects, taskList: tasks, onlyProjectId: normalized.projectId }),
    }));
    if (unclassifiedIds.length) {
      buckets.push({
        key: 'unclassified',
        label: UNCLASSIFIED_LABEL,
        kind: 'unclassified',
        roleIds: unclassifiedIds.slice(),
        counts: countsOf(unclassifiedIds, { projectList: projects, taskList: tasks, onlyProjectId: normalized.projectId }),
      });
    }
    return {
      scope: normalized.value,
      focusId: focusProject ? focusProject.id : normalized.projectId,
      buckets,
      unclassifiedIds,
      unassignedIds: [],
    };
  }

  // scope 'all'
  const groups = new Map();
  const unclassifiedIds = [];
  for (const org of organizations) {
    const role = roleOfOrg(org);
    if (role === null) {
      unclassifiedIds.push(org.id);
      continue;
    }
    if (!groups.has(role)) groups.set(role, { role, ids: [], order: groups.size });
    groups.get(role).ids.push(org.id);
  }
  const buckets = orderedRoleGroups(groups, templateRoles('custom')).map(group => ({
    key: group.role,
    label: roleLabel(group.role),
    kind: 'role',
    roleIds: group.ids.slice(),
    counts: countsOf(group.ids, { projectList: projects, taskList: tasks }),
  }));
  // 未归属项目单列一桶（spec/53 §2.2）；有 partnerId 的旧项目不算未归属，也不猜它的归属机构。
  const unassignedProjects = projects.filter(project => !textOf(project.organizationId) && !textOf(project.partnerId));
  const unassignedIds = unassignedProjects.map(project => project.id);
  if (unassignedIds.length) {
    buckets.push({
      key: 'unassigned',
      label: UNASSIGNED_LABEL,
      kind: 'unassigned',
      roleIds: unassignedIds.slice(),
      counts: countsOfProjects(unassignedIds, tasks),
    });
  }
  // 「未分类」永远最后。
  if (unclassifiedIds.length) {
    buckets.push({
      key: 'unclassified',
      label: UNCLASSIFIED_LABEL,
      kind: 'unclassified',
      roleIds: unclassifiedIds.slice(),
      counts: countsOf(unclassifiedIds, { projectList: projects, taskList: tasks }),
    });
  }
  return {
    scope: DEFAULT_SCOPE,
    focusId: null,
    buckets,
    unclassifiedIds,
    unassignedIds,
  };
}

/** 单击展开什么：机构 → 它的项目（organizationId 主责 或 participants 参与，去重）；
 *  项目 → 它的任务；其它 kind / 不存在的 id → 空列表。
 *  scope 只为接线对称保留：结构关系本身与 scope 无关（全部机构视图里点机构、项目视图里点焦点项目）。
 *  partnerId 不当作参与（旧数据在 A1 迁移时才会映射成 participants 的一条），只用于「未归属」判定。 */
export function childrenOf(id, { nodes } = {}) {
  const nodeId = textOf(id);
  const list = asArray(nodes);
  const node = nodeId ? list.find(item => item && item.id === nodeId) : null;
  if (!node) return { kind: 'org', items: [] };
  if (nodeKind(node) === 'project') {
    const items = [];
    for (const candidate of list) {
      if (nodeKind(candidate) !== 'task') continue;
      if (textOf(candidate.projectId) === nodeId) items.push(candidate.id);
    }
    return { kind: 'project', items: [...new Set(items)] };
  }
  if (nodeKind(node) === 'organization') {
    const items = [];
    for (const candidate of list) {
      if (nodeKind(candidate) !== 'project') continue;
      if (projectOrgIds(candidate).includes(nodeId)) items.push(candidate.id);
    }
    return { kind: 'org', items: [...new Set(items)] };
  }
  return { kind: 'org', items: [] };
}

/** 展开状态机（D4：一次只展开一个分支），纯函数、不修改入参。
 *   · id 为空（点空白 / Esc 由调用方传空）→ 收起；
 *   · 点当前已展开的 id → 收起；
 *   · 点另一个可展开节点（机构/项目）→ 替换；没有子项也保持展开，调用方显示空态；
 *   · 点不存在或不可展开的节点（任务/资料/…）→ 原样返回（不变）。
 */
export function expandState(state, id, { nodes } = {}) {
  const current = {
    expandedId: typeof state?.expandedId === 'string' && state.expandedId ? state.expandedId : null,
    itemIds: asArray(state?.itemIds).map(textOf).filter(Boolean),
  };
  const nodeId = textOf(id);
  const collapse = { expandedId: null, itemIds: [] };
  if (!nodeId) return collapse;
  if (current.expandedId === nodeId) return collapse;
  const list = asArray(nodes);
  const node = list.find(item => item && item.id === nodeId);
  const kind = nodeKind(node);
  if (kind !== 'organization' && kind !== 'project') return current;
  const children = childrenOf(nodeId, { nodes: list });
  return { expandedId: nodeId, itemIds: children.items };
}

/** 子卡生长方向：从机构朝**远离画布中心**的一侧长（右半区向右、左半区向左；上下同理）。
 *  正好在中线上 / center 缺失 → 默认向右、向下（spec/54 §2.3）。
 *  center 建议传**当前视口中心的世界坐标**（gx/zoom 换算），不要传内容包围盒中心：
 *  内容包围盒会随展开变化，方向就会跟着抖。 */
export function outwardDir(parentRect, center) {
  const parent = rectOf(parentRect) ?? { x: 0, y: 0, w: 0, h: 0 };
  const cx = typeof center?.x === 'number' && Number.isFinite(center.x) ? center.x : NaN;
  const cy = typeof center?.y === 'number' && Number.isFinite(center.y) ? center.y : NaN;
  const parentX = parent.x + parent.w / 2;
  const parentY = parent.y + parent.h / 2;
  return {
    x: Number.isFinite(cx) && parentX < cx ? -1 : 1,
    y: Number.isFinite(cy) && parentY < cy ? -1 : 1,
  };
}

/** 世界坐标矩形：同时接受 {w,h} 与 {width,height}；非法值按 0 处理（不猜尺寸）。 */
const rectOf = rect => {
  if (!rect || typeof rect !== 'object') return null;
  return {
    x: numOf(rect.x),
    y: numOf(rect.y),
    w: Math.max(0, numOf(rect.w ?? rect.width)),
    h: Math.max(0, numOf(rect.h ?? rect.height)),
  };
};
const overlaps = (left, right) => left.x < right.x + right.w && right.x < left.x + left.w && left.y < right.y + right.h && right.y < left.y + left.h;
const unionRects = rects => {
  if (!rects.length) return null;
  let x = Infinity;
  let y = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    x = Math.min(x, rect.x);
    y = Math.min(y, rect.y);
    right = Math.max(right, rect.x + rect.w);
    bottom = Math.max(bottom, rect.y + rect.h);
  }
  return { x, y, w: right - x, h: bottom - y };
};

/** 原地展开布局：子卡在父卡旁边排一列（项目卡、任务卡同一套）。
 *
 *  · 列的位置：dir.x>0 放父卡右边（父卡右边缘 + gap），dir.x<0 放左边（整列最左 = 父卡左边缘 - gap - 列宽）；
 *  · 纵向：dir.y>0 从父卡顶部向下排，dir.y<0 从父卡底部向上排；顺序严格按 children 入参；
 *  · 与 occupied 重叠时**只沿纵向继续外推**（不横向乱挪），也不改动父卡位置；
 *  · bounds = 父卡 + 全部子卡的包围盒，直接喂给 fitRect（spec/54 §2.3「fitRect(机构+子节点)」）。
 *  确定性：同输入同输出；不修改 parentRect / children / occupied 里的任何对象。
 */
export function expandLayout({ parentRect, children, occupied, dir, gap = 40 } = {}) {
  const parent = rectOf(parentRect) ?? { x: 0, y: 0, w: 0, h: 0 };
  const gapValue = Number.isFinite(gap) ? Math.max(0, gap) : 40;
  const direction = { x: dir?.x < 0 ? -1 : 1, y: dir?.y < 0 ? -1 : 1 };
  const childList = [];
  const seen = new Set();
  for (const child of asArray(children)) {
    if (!child || typeof child.id !== 'string' || !child.id || seen.has(child.id)) continue;
    seen.add(child.id);
    childList.push({ id: child.id, w: Math.max(0, numOf(child.w ?? child.width)), h: Math.max(0, numOf(child.h ?? child.height)) });
  }
  const occupiedRects = asArray(occupied).map(rectOf).filter(Boolean);
  const positions = {};
  const placed = [];
  const columnWidth = childList.reduce((max, child) => Math.max(max, child.w), 0);
  const columnX = direction.x > 0 ? parent.x + parent.w + gapValue : parent.x - gapValue - columnWidth;
  let cursorTop = parent.y;
  let cursorBottom = parent.y + parent.h;
  const stepLimit = occupiedRects.length + childList.length + 8;
  for (const child of childList) {
    let y = direction.y > 0 ? cursorTop : cursorBottom - child.h;
    let steps = 0;
    while (steps < stepLimit && occupiedRects.concat(placed).some(rect => overlaps({ x: columnX, y, w: child.w, h: child.h }, rect))) {
      y += direction.y * (child.h + gapValue);
      steps += 1;
    }
    positions[child.id] = { x: clean(columnX), y: clean(y) };
    placed.push({ x: columnX, y, w: child.w, h: child.h });
    if (direction.y > 0) cursorTop = y + child.h + gapValue;
    else cursorBottom = y - gapValue;
  }
  const bounds = unionRects([parent, ...placed]) ?? { x: 0, y: 0, w: 0, h: 0 };
  return {
    positions,
    bounds: { x: clean(bounds.x), y: clean(bounds.y), w: clean(bounds.w), h: clean(bounds.h) },
  };
}

/** 镜头：把若干世界矩形放进视口（中心对齐，zoom 夹在 [minZoom, maxZoom]）。
 *  与 space-view-v5 的 transform（translate(gx,gy) scale(zoom)）同一坐标系：
 *  屏幕坐标 = 世界坐标 * zoom + gx/gy。
 *  空输入 / 无有效视口 → 安全默认 {zoom:1,gx:20,gy:20}（与现有 fit() 的兜底一致）。 */
export function fitRect({ rects, viewport, padding = 60, minZoom = 0.6, maxZoom = 1.0 } = {}) {
  const safe = { zoom: 1, gx: 20, gy: 20 };
  const rectList = asArray(rects).map(rectOf).filter(Boolean);
  const bounds = unionRects(rectList);
  const viewWidth = numOf(viewport?.w ?? viewport?.width);
  const viewHeight = numOf(viewport?.h ?? viewport?.height);
  if (!bounds || viewWidth <= 0 || viewHeight <= 0) return safe;
  const pad = Math.max(0, numOf(padding));
  const availableWidth = viewWidth - pad * 2;
  const availableHeight = viewHeight - pad * 2;
  const rawZoom = Math.min(bounds.w > 0 ? availableWidth / bounds.w : Infinity, bounds.h > 0 ? availableHeight / bounds.h : Infinity);
  const low = Number.isFinite(minZoom) ? minZoom : 0.6;
  const high = Number.isFinite(maxZoom) ? maxZoom : 1.0;
  const bounded = Math.min(high, Math.max(low, Number.isFinite(rawZoom) ? rawZoom : high));
  const zoom = Number.isFinite(bounded) && bounded > 0 ? bounded : 1;
  return {
    zoom: clean(zoom),
    gx: clean((viewWidth - bounds.w * zoom) / 2 - bounds.x * zoom),
    gy: clean((viewHeight - bounds.h * zoom) / 2 - bounds.y * zoom),
  };
}

/** 语义缩放三档（VI §9；阈值与 space-view-v5 的 nodeDetailAt / showsEdgeLabels 完全一致）：
 *  <60% 名称+类型；60–110% 状态/计数；>110% 关系文字。改一处必须同步另一处。 */
export function semanticTier(zoom) {
  if (zoom < TIER_NAME_MAX) return 'name';
  if (zoom > TIER_RELATION_MIN) return 'relation';
  return 'status';
}

/** 角色名 → 稳定序号（index 缺失时用；同一角色名永远同一序号）。 */
const stableRoleIndex = role => {
  const text = typeof role === 'string' ? role : '';
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) % 1000003;
  return hash;
};

/** 角色视觉：确定性映射到已登记调色板 token + 5 种形状（按 index 循环）。
 *  未分类/未归属由调用方直接用 UNCLASSIFIED_VISUAL / UNASSIGNED_VISUAL（灰 + 问号语义）。
 *  返回的 colorToken 只可能是 --pal-* 名字，绝不返回 hex。 */
export function roleVisual(role, index) {
  const base = Number.isFinite(index) ? Math.trunc(index) : stableRoleIndex(role);
  // 取模：负数也落在合法下标上。
  const wrap = (value, length) => ((value % length) + length) % length;
  return {
    colorToken: PALETTE_TOKENS[wrap(base, PALETTE_TOKENS.length)],
    shape: SHAPES[wrap(base, SHAPES.length)],
  };
}

/** 容量提示：角色/分类桶过多、单桶机构过多时的**如实**文案；
 *  只提示，不等同于「已经聚合」——聚合/折叠是视图层的动作（本模块不丢数据）。
 *  入参 nodeCount = 单个桶内机构数量的最大值（不是全部节点总数）。 */
export function capacityReport({ bucketCount = 0, nodeCount = 0 } = {}) {
  const buckets = Math.max(0, Math.trunc(numOf(bucketCount)));
  const nodes = Math.max(0, Math.trunc(numOf(nodeCount)));
  const overBuckets = buckets > MAX_ROLE_BUCKETS;
  const overNodes = nodes > BUCKET_AGGREGATE_LIMIT;
  let message;
  if (overBuckets && overNodes) {
    message = `角色 ${buckets} 类、单桶 ${nodes} 个机构，超过建议上限（${MAX_ROLE_BUCKETS} 类 / 单桶 ${BUCKET_AGGREGATE_LIMIT} 个）；请合并相近角色，机构多的桶先折叠或翻页。`;
  } else if (overBuckets) {
    message = `角色 ${buckets} 类，超过建议上限 ${MAX_ROLE_BUCKETS} 类；请合并相近角色，或把多出的角色归入「其他」。`;
  } else if (overNodes) {
    message = `单桶机构 ${nodes} 个，超过建议一次显示的 ${BUCKET_AGGREGATE_LIMIT} 个；请先折叠或翻页。`;
  } else {
    message = `角色 ${buckets} 类 · 单桶最多 ${nodes} 个机构，在建议上限内。`;
  }
  return { overCap: overBuckets || overNodes, message };
}
