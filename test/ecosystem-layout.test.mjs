import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {nodeDetailAt, showsEdgeLabels} from '../prototype/space-view-v5.mjs';
import {
  ROLE_LABELS, ROLE_KEYS, ROLE_TEMPLATES, PALETTE_TOKENS, SHAPES,
  UNCLASSIFIED_LABEL, UNASSIGNED_LABEL, UNCLASSIFIED_VISUAL, UNASSIGNED_VISUAL,
  MAX_ROLE_BUCKETS, BUCKET_AGGREGATE_LIMIT, TIER_NAME_MAX, TIER_RELATION_MIN,
  roleLabel, templateRoles, roleOfOrg, roleOfParticipant,
  classify, childrenOf, expandState, outwardDir, expandLayout, fitRect,
  semanticTier, roleVisual, capacityReport,
} from '../prototype/ecosystem-layout.mjs';

// 测试夹具：角色名是自由文本（A1 契约），这里只造最小结构，不写产品默认数据。
const org = (id, title, defaultRole) => (defaultRole === undefined ? {id, kind: 'organization', title} : {id, kind: 'organization', title, defaultRole});
const project = (id, title, extra = {}) => ({id, kind: 'project', title, ...extra});
const task = (id, title, projectId) => (projectId === undefined ? {id, kind: 'task', title} : {id, kind: 'task', title, projectId});

const ALL_NODES = [
  org('o1', '我方机构', 'self'),
  org('o2', '客户机构', 'client'),
  org('o3', '伙伴机构', 'partner'),
  org('o4', '算力供应商', '算力供应商'),
  org('o5', '未分类机构'),
  project('p1', '项目一', {organizationId: 'o1', participants: [{organizationId: 'o2', role: 'client'}, {organizationId: 'o3', role: 'partner'}]}),
  project('p2', '项目二', {organizationId: 'o2', participants: [{organizationId: 'o1', role: 'partner'}, {organizationId: 'o4', role: '算力供应商'}]}),
  project('p3', '未归属项目'),
  project('p4', '旧伙伴项目', {partnerId: 'o3'}),
  task('t1', '任务一', 'p1'),
  task('t2', '任务二', 'p1'),
  task('t3', '任务三', 'p2'),
  task('t4', '任务四', 'p3'),
];

const bucketOf = (result, key) => result.buckets.find(bucket => bucket.key === key);
const bucketsOf = result => result.buckets;
const keysOf = result => result.buckets.map(bucket => bucket.key);
const labelsOf = result => result.buckets.map(bucket => bucket.label);

// ---------------------------------------------------------------- 常量 / 角色表

test('角色表：通用 8 类 + 其他，键顺序与中文名固定', () => {
  assert.deepEqual([...ROLE_KEYS], ['self', 'client', 'partner', 'supply', 'research', 'standard', 'capital', 'competitor', 'other']);
  assert.deepEqual(Object.keys(ROLE_LABELS), [...ROLE_KEYS]);
  assert.deepEqual(ROLE_KEYS.map(key => ROLE_LABELS[key]), ['主体', '客户', '伙伴', '供应', '研究政策', '标准行业', '资本渠道', '竞争替代', '其他']);
  assert.equal(UNCLASSIFIED_LABEL, '未分类');
  assert.equal(UNASSIGNED_LABEL, '未归属');
});

test('角色模板：5 个模板、顺序与 spec/54 §1.4 一致、只是建议不限制角色名', () => {
  assert.deepEqual(Object.keys(ROLE_TEMPLATES), ['delivery', 'ecosystem', 'investment', 'research', 'custom']);
  assert.deepEqual(ROLE_TEMPLATES.delivery.roles, ['self', 'client', 'partner', 'supply', 'standard', 'other']);
  assert.deepEqual(ROLE_TEMPLATES.ecosystem.roles, ['self', 'research', 'supply', 'client', 'partner', 'standard', 'capital', 'other']);
  assert.deepEqual(ROLE_TEMPLATES.investment.roles, ['self', 'supply', 'client', 'capital', 'research', 'competitor', 'other']);
  assert.deepEqual(ROLE_TEMPLATES.research.roles, ['self', 'research', 'partner', 'standard', 'capital', 'competitor', 'other']);
  assert.deepEqual(ROLE_TEMPLATES.custom.roles, [...ROLE_KEYS]);
  for (const key of Object.keys(ROLE_TEMPLATES)) {
    const template = ROLE_TEMPLATES[key];
    assert.equal(typeof template.label, 'string');
    assert.ok(template.label.length > 0, '模板必须有中文名');
    assert.equal(new Set(template.roles).size, template.roles.length, '模板角色不重复');
    for (const role of template.roles) assert.ok(ROLE_KEYS.includes(role), '模板只能用通用角色键：' + role);
  }
  // 未知模板退回自定义顺序；返回的是副本，改它不会污染常量。
  assert.deepEqual(templateRoles('没有这个模板'), [...ROLE_KEYS]);
  const copy = templateRoles('delivery');
  copy.push('custom-only');
  assert.deepEqual(ROLE_TEMPLATES.delivery.roles, ['self', 'client', 'partner', 'supply', 'standard', 'other']);
});

test('角色显示名：通用键翻译、自由文本原样、空=未分类', () => {
  assert.equal(roleLabel('client'), '客户');
  assert.equal(roleLabel('other'), '其他');
  assert.equal(roleLabel('  监管方  '), '监管方', '自定义角色原样显示，不翻译');
  assert.equal(roleLabel(''), UNCLASSIFIED_LABEL);
  assert.equal(roleLabel(null), UNCLASSIFIED_LABEL);
  assert.equal(roleLabel(undefined), UNCLASSIFIED_LABEL);
});

test('roleOfOrg / roleOfParticipant：trim 后非空才返回角色，找不到就是 null', () => {
  assert.equal(roleOfOrg({defaultRole: 'client'}), 'client');
  assert.equal(roleOfOrg({defaultRole: '  客户  '}), '客户');
  assert.equal(roleOfOrg({defaultRole: ''}), null);
  assert.equal(roleOfOrg({defaultRole: '   '}), null);
  assert.equal(roleOfOrg({}), null);
  assert.equal(roleOfOrg(null), null);
  assert.equal(roleOfOrg({defaultRole: 42}), null);

  const one = project('p', '项目', {participants: [{organizationId: 'o1', role: ' 客户 '}, {organizationId: 'o2', role: '   '}]});
  assert.equal(roleOfParticipant(one, 'o1'), '客户');
  assert.equal(roleOfParticipant(one, 'o2'), null, 'role 为空 = 未分类');
  assert.equal(roleOfParticipant(one, 'o3'), null, '不在参与者里 = 没有该项目的角色');
  assert.equal(roleOfParticipant(one, ''), null);
  assert.equal(roleOfParticipant(null, 'o1'), null);
});

// ---------------------------------------------------------------- classify · all

test('classify(all)：按 defaultRole 分组，项目不自己成桶，未分类永远最后', () => {
  const result = classify({nodes: ALL_NODES, scope: 'all'});
  assert.equal(result.scope, 'all');
  assert.equal(result.focusId, null);
  assert.deepEqual(keysOf(result), ['self', 'client', 'partner', '算力供应商', 'unassigned', 'unclassified']);
  assert.deepEqual(labelsOf(result), ['主体', '客户', '伙伴', '算力供应商', '未归属', '未分类']);
  assert.deepEqual(bucketsOf(result).map(bucket => bucket.kind), ['role', 'role', 'role', 'role', 'unassigned', 'unclassified']);
  // 项目不自己成桶：任何桶的 roleIds 都不会是项目 ID（未归属桶除外）。
  for (const bucket of result.buckets.filter(item => item.kind === 'role')) {
    assert.ok(bucket.roleIds.every(id => id.startsWith('o')), '角色桶只收机构');
  }
  // 未分类桶永远最后，未归属在它前面。
  assert.equal(result.buckets.at(-1).kind, 'unclassified');
  assert.equal(result.buckets.at(-2).kind, 'unassigned');
});

test('classify(all)：桶内机构、计数、未分类与未归属 ID 都如实', () => {
  const result = classify({nodes: ALL_NODES, scope: 'all'});
  assert.deepEqual(bucketOf(result, 'self').roleIds, ['o1']);
  assert.deepEqual(bucketOf(result, 'client').roleIds, ['o2']);
  assert.deepEqual(bucketOf(result, 'partner').roleIds, ['o3']);
  assert.deepEqual(bucketOf(result, '算力供应商').roleIds, ['o4']);
  assert.deepEqual(bucketOf(result, 'unclassified').roleIds, ['o5']);
  assert.deepEqual(result.unclassifiedIds, ['o5']);
  assert.deepEqual(result.unassignedIds, ['p3'], '没有 organizationId 也没有 partnerId 的项目才算未归属');
  assert.deepEqual(bucketOf(result, 'unassigned').roleIds, ['p3'], '未归属桶成员是项目 ID');

  // 计数 = 从桶内机构沿结构下钻（主责 + 参与）。
  assert.deepEqual(bucketOf(result, 'self').counts, {organizations: 1, projects: 2, tasks: 3}, 'o1 主责 p1、参与 p2');
  assert.deepEqual(bucketOf(result, 'client').counts, {organizations: 1, projects: 2, tasks: 3});
  assert.deepEqual(bucketOf(result, 'partner').counts, {organizations: 1, projects: 1, tasks: 2}, 'partnerId 只是旧兼容字段，不算参与');
  assert.deepEqual(bucketOf(result, '算力供应商').counts, {organizations: 1, projects: 1, tasks: 1});
  assert.deepEqual(bucketOf(result, 'unassigned').counts, {organizations: 0, projects: 1, tasks: 1});
  assert.deepEqual(bucketOf(result, 'unclassified').counts, {organizations: 1, projects: 0, tasks: 0});
  // JSON 可序列化：没有 undefined / Map / 函数。
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('classify：默认 scope 是 all（D8），不认识/空 scope 也退回 all', () => {
  assert.equal(classify({nodes: ALL_NODES}).scope, 'all');
  assert.equal(classify({nodes: ALL_NODES, scope: ''}).scope, 'all');
  assert.equal(classify({nodes: ALL_NODES, scope: 'bogus'}).scope, 'all');
  assert.equal(classify({nodes: [], scope: 'project:'}).scope, 'all');
  assert.equal(classify({nodes: []}).focusId, null);
  assert.deepEqual(classify({nodes: []}).buckets, []);
});

test('classify(all)：自定义角色名原样保留；通用角色中文标签也按模板位置排序', () => {
  const nodes = [
    org('a', '自定义机构', '战略合作方'),
    org('b', '中文客户', '客户'),
    org('c', '主体机构', 'self'),
  ];
  const result = classify({nodes, scope: 'all'});
  // self 是模板第 0 位；「客户」等于 client 的中文标签，按 client 位（第 1）排；自定义角色按首次出现追加。
  assert.deepEqual(keysOf(result), ['self', '客户', '战略合作方']);
  assert.deepEqual(labelsOf(result), ['主体', '客户', '战略合作方']);
  assert.deepEqual(bucketOf(result, '战略合作方').roleIds, ['a'], '自定义角色名不翻译、不丢');
});

test('classify(all)：同一机构只按全局 defaultRole 归一个桶（项目角色不影响全局视图）', () => {
  const nodes = [
    org('o1', '机构一', 'client'),
    org('o2', '机构二', 'partner'),
    project('p1', '项目一', {organizationId: 'o1', participants: [{organizationId: 'o2', role: 'client'}]}),
  ];
  const result = classify({nodes, scope: 'all'});
  assert.deepEqual(bucketOf(result, 'client').roleIds, ['o1'], 'all scope 只看 defaultRole');
  assert.deepEqual(bucketOf(result, 'partner').roleIds, ['o2']);
  assert.equal(bucketOf(result, 'partner').roleIds.includes('o1'), false);
});

// ---------------------------------------------------------------- classify · project

test('classify(project)：同一机构在两个项目分别是客户/伙伴，各归各桶不冲突', () => {
  const nodes = [
    org('o1', '主体机构', 'self'),
    org('o2', '客户机构', 'client'),
    org('o3', '伙伴机构', 'partner'),
    project('p1', '交付项目', {organizationId: 'o1', roleTemplate: 'delivery', participants: [{organizationId: 'o1', role: 'self'}, {organizationId: 'o2', role: 'client'}, {organizationId: 'o3', role: 'partner'}]}),
    project('p2', '投资项目', {organizationId: 'o2', roleTemplate: 'investment', participants: [{organizationId: 'o2', role: 'partner'}, {organizationId: 'o1', role: 'self'}]}),
    task('t1', '任务一', 'p1'),
    task('t2', '任务二', 'p1'),
    task('t3', '任务三', 'p2'),
  ];
  const p1 = classify({nodes, scope: 'project:p1'});
  const p2 = classify({nodes, scope: 'project:p2'});
  assert.equal(p1.focusId, 'p1');
  assert.equal(p2.focusId, 'p2');
  assert.equal(p1.scope, 'project:p1');
  // delivery 模板顺序：self → client → partner
  assert.deepEqual(keysOf(p1), ['self', 'client', 'partner']);
  assert.deepEqual(bucketOf(p1, 'client').roleIds, ['o2']);
  assert.deepEqual(bucketOf(p1, 'client').counts, {organizations: 1, projects: 1, tasks: 2});
  // investment 模板里没有 partner：self 在前，partner 作为未知角色稳定追加。
  assert.deepEqual(keysOf(p2), ['self', 'partner']);
  assert.deepEqual(bucketOf(p2, 'partner').roleIds, ['o2']);
  assert.equal(bucketOf(p2, 'partner').label, '伙伴');
  assert.equal(bucketOf(p2, 'client'), undefined, '项目视图只认 participants 的角色，不认全局 defaultRole');
  // 两个项目各自的参与者角色互不打扰。
  assert.equal(bucketOf(p1, 'client').roleIds.includes('o2'), true);
  assert.equal(bucketOf(p2, 'partner').roleIds.includes('o2'), true);
});

test('classify(project)：桶顺序按项目 roleTemplate，自定义角色稳定追加', () => {
  const nodes = [
    org('o1', '主体机构', 'self'),
    org('o2', '资本机构', 'capital'),
    org('o3', '研究机构', 'research'),
    org('o4', '监管机构', '监管方'),
    project('p1', '研判项目', {
      roleTemplate: 'investment',
      participants: [
        {organizationId: 'o4', role: '监管方'},
        {organizationId: 'o3', role: 'research'},
        {organizationId: 'o2', role: 'capital'},
        {organizationId: 'o1', role: 'self'},
      ],
    }),
  ];
  const result = classify({nodes, scope: 'project:p1'});
  // investment：self(0) → capital(3) → research(4)，未知角色最后。
  assert.deepEqual(keysOf(result), ['self', 'capital', 'research', '监管方']);
  assert.deepEqual(bucketOf(result, '监管方').roleIds, ['o4']);
  // 未知模板退回 custom 顺序（self → client → supply）。
  const custom = classify({
    nodes: [
      org('a', 'A', 'supply'),
      org('b', 'B', 'self'),
      org('c', 'C', 'client'),
      project('px', '自定义项目', {roleTemplate: '不存在的模板', participants: [{organizationId: 'a', role: 'supply'}, {organizationId: 'b', role: 'self'}, {organizationId: 'c', role: 'client'}]}),
    ],
    scope: 'project:px',
  });
  assert.deepEqual(keysOf(custom), ['self', 'client', 'supply']);
});

test('classify(project)：participants 为空 → 空桶列表 + focus；失效引用不生成幽灵桶', () => {
  const nodes = [org('o1', '机构', 'self'), project('p1', '空项目', {organizationId: 'o1'})];
  const empty = classify({nodes, scope: 'project:p1'});
  assert.deepEqual(empty.buckets, [], '调用方显示「这个项目还没有参与机构」');
  assert.equal(empty.focusId, 'p1');
  assert.deepEqual(empty.unclassifiedIds, []);
  assert.deepEqual(empty.unassignedIds, []);
  const missing = classify({nodes: [org('o1', '机构', 'self')], scope: 'project:没有这个项目'});
  assert.deepEqual(missing.buckets, []);
  assert.equal(missing.focusId, '没有这个项目');
  const ghost = classify({
    nodes: [project('p1', '项目', {participants: [{organizationId: '不存在', role: 'client'}]})],
    scope: 'project:p1',
  });
  assert.deepEqual(ghost.buckets, [], 'participants 引用失效时不画不存在的卡');
});

test('classify(project)：participants 里没写角色的机构进未分类桶，且未分类最后', () => {
  const nodes = [
    org('o1', '机构一', 'self'),
    org('o2', '机构二', 'client'),
    project('p1', '项目', {participants: [{organizationId: 'o1', role: 'client'}, {organizationId: 'o2', role: '   '}]}),
  ];
  const result = classify({nodes, scope: 'project:p1'});
  assert.deepEqual(keysOf(result), ['client', 'unclassified']);
  assert.deepEqual(bucketOf(result, 'unclassified').roleIds, ['o2']);
  assert.deepEqual(result.unclassifiedIds, ['o2']);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

// ---------------------------------------------------------------- childrenOf

test('childrenOf：机构→项目（主责 + 参与都算、去重），项目→任务，没有子节点返回空', () => {
  const nodes = [
    org('o1', '我方机构', 'self'),
    org('o2', '客户机构', 'client'),
    org('o3', '伙伴机构', 'partner'),
    org('o4', '空机构', 'other'),
    project('p1', '项目一', {organizationId: 'o2', participants: [{organizationId: 'o1', role: 'self'}]}),
    project('p2', '项目二', {participants: [{organizationId: 'o1', role: 'partner'}]}),
    project('p3', '未归属项目'),
    task('t1', '任务一', 'p1'),
    task('t2', '任务二', 'p1'),
    task('t3', '任务三', 'p3'),
  ];
  assert.deepEqual(childrenOf('o1', {nodes}), {kind: 'org', items: ['p1', 'p2']});
  assert.deepEqual(childrenOf('o2', {nodes}), {kind: 'org', items: ['p1']});
  assert.deepEqual(childrenOf('o4', {nodes}), {kind: 'org', items: []});
  assert.deepEqual(childrenOf('p1', {nodes}), {kind: 'project', items: ['t1', 't2']});
  assert.deepEqual(childrenOf('p3', {nodes}), {kind: 'project', items: ['t3']});
  assert.deepEqual(childrenOf('nope', {nodes}), {kind: 'org', items: []});
  assert.deepEqual(childrenOf('t1', {nodes}), {kind: 'org', items: []}, '任务不可展开');
  assert.deepEqual(childrenOf(null, {nodes}), {kind: 'org', items: []});
  // 同一项目同时主责 + 参与，只出现一次。
  const both = [org('o1', '机构', 'self'), project('p1', '项目', {organizationId: 'o1', participants: [{organizationId: 'o1', role: 'self'}]})];
  assert.deepEqual(childrenOf('o1', {nodes: both}).items, ['p1'], '去重');
  // partnerId 是旧数据兼容字段，不当作参与去猜归属；它只在「未归属」判定里出现。
  assert.deepEqual(childrenOf('o3', {nodes: [...nodes, project('p4', '旧伙伴项目', {partnerId: 'o3'})]}).items, []);
});

// ---------------------------------------------------------------- expandState

test('expandState：点同一个收起、点别的替换（一次只展开一个分支）', () => {
  const nodes = [
    org('o1', '机构一', 'self'),
    org('o2', '机构二', 'client'),
    project('p1', '项目一', {organizationId: 'o1', participants: [{organizationId: 'o2', role: 'client'}]}),
    project('p2', '项目二', {organizationId: 'o2'}),
    task('t1', '任务一', 'p1'),
    task('t2', '任务二', 'p1'),
  ];
  const initial = {expandedId: null, itemIds: []};
  const first = expandState(initial, 'o1', {nodes});
  assert.deepEqual(first, {expandedId: 'o1', itemIds: ['p1']});
  assert.deepEqual(initial, {expandedId: null, itemIds: []}, '不修改入参');
  // 点同一个 → 收起
  assert.deepEqual(expandState(first, 'o1', {nodes}), {expandedId: null, itemIds: []});
  // 点另一个 → 替换（不会两个同时展开）
  const replaced = expandState(first, 'p1', {nodes});
  assert.deepEqual(replaced, {expandedId: 'p1', itemIds: ['t1', 't2']});
  const switched = expandState(replaced, 'o2', {nodes});
  assert.deepEqual(switched, {expandedId: 'o2', itemIds: ['p1', 'p2']});
  assert.equal(switched.expandedId === 'o1', false);
});

test('expandState：点空白收起、点无效/不可展开保持不变、没有子项也保持展开显示空态', () => {
  const nodes = [
    org('o1', '机构一', 'self'),
    org('o2', '空机构', 'other'),
    project('p1', '项目一', {organizationId: 'o1'}),
    task('t1', '任务一', 'p1'),
    {id: 'a1', kind: 'artifact', title: '资料一'},
  ];
  const expanded = {expandedId: 'p1', itemIds: ['t1']};
  assert.deepEqual(expandState(expanded, null, {nodes}), {expandedId: null, itemIds: []});
  assert.deepEqual(expandState(expanded, '', {nodes}), {expandedId: null, itemIds: []});
  assert.deepEqual(expandState(expanded, 't1', {nodes}), expanded, '任务单击高亮，不展开分支');
  assert.deepEqual(expandState(expanded, 'a1', {nodes}), expanded, '资料不展开');
  assert.deepEqual(expandState(expanded, 'nope', {nodes}), expanded, '无效 id 不变');
  assert.deepEqual(expandState(null, 'o2', {nodes}), {expandedId: 'o2', itemIds: []}, '没有子节点也展开，由调用方显示空态');
  assert.deepEqual(expandState(undefined, 'o1', {nodes}), {expandedId: 'o1', itemIds: ['p1']});
  // 冻结的入参不会被写（纯函数）。
  const frozen = Object.freeze({expandedId: 'o1', itemIds: Object.freeze(['p1'])});
  assert.equal(expandState(frozen, null, {nodes}).expandedId, null);
});

// ---------------------------------------------------------------- outwardDir

test('outwardDir：四个象限朝远离画布中心的方向长；中心附近默认向右/向下', () => {
  const center = {x: 0, y: 0};
  assert.deepEqual(outwardDir({x: 100, y: 100, w: 10, h: 10}, center), {x: 1, y: 1}, '右下半区 → 右下');
  assert.deepEqual(outwardDir({x: -100, y: -100, w: 10, h: 10}, center), {x: -1, y: -1}, '左上半区 → 左上');
  assert.deepEqual(outwardDir({x: 100, y: -100, w: 10, h: 10}, center), {x: 1, y: -1}, '右上半区 → 右上');
  assert.deepEqual(outwardDir({x: -100, y: 100, w: 10, h: 10}, center), {x: -1, y: 1}, '左下半区 → 左下');
  assert.deepEqual(outwardDir({x: -5, y: -5, w: 10, h: 10}, center), {x: 1, y: 1}, '正好在中心 → 右/下');
  assert.deepEqual(outwardDir({x: 0, y: 0, w: 200, h: 86}, {x: 200, y: 0}), {x: -1, y: 1}, '按父卡中心与中心比较');
  assert.deepEqual(outwardDir({x: 10, y: 10, w: 10, h: 10}), {x: 1, y: 1}, '缺 center 用安全默认');
  assert.deepEqual(outwardDir({x: 10, y: 10, width: 10, height: 10}, center), {x: 1, y: 1}, '接受 width/height');
});

// ---------------------------------------------------------------- expandLayout

test('expandLayout：子卡在父卡旁边排一列，不重叠父卡、父卡位置不变', () => {
  const parentRect = {x: 100, y: 100, w: 140, h: 56};
  const before = JSON.parse(JSON.stringify(parentRect));
  const children = [{id: 'a', w: 200, h: 86}, {id: 'b', w: 180, h: 72}];
  const result = expandLayout({parentRect, children, occupied: [], dir: {x: 1, y: 1}, gap: 40});
  assert.deepEqual(result.positions, {a: {x: 280, y: 100}, b: {x: 280, y: 226}});
  assert.deepEqual(result.bounds, {x: 100, y: 100, w: 380, h: 198});
  assert.deepEqual(parentRect, before, '绝不修改父节点位置');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  // 子卡与父卡、子卡彼此都不重叠。
  const rect = child => ({x: result.positions[child.id].x, y: result.positions[child.id].y, w: child.w, h: child.h});
  const overlap = (left, right) => left.x < right.x + right.w && right.x < left.x + left.w && left.y < right.y + right.h && right.y < left.y + left.h;
  for (const child of children) assert.equal(overlap(rect(child), parentRect), false);
  assert.equal(overlap(rect(children[0]), rect(children[1])), false);
});

test('expandLayout：向左/向上生长方向正确，反向仍不重叠父卡', () => {
  const parentRect = {x: 100, y: 100, w: 140, h: 56};
  const children = [{id: 'a', w: 200, h: 86}, {id: 'b', w: 180, h: 72}];
  const left = expandLayout({parentRect, children, dir: {x: -1, y: 1}, gap: 40});
  assert.deepEqual(left.positions, {a: {x: -140, y: 100}, b: {x: -140, y: 226}}, '整列在父卡左侧，右边缘留 gap');
  assert.ok(left.positions.a.x + 200 <= parentRect.x - 40);
  const up = expandLayout({parentRect, children, dir: {x: 1, y: -1}, gap: 40});
  assert.deepEqual(up.positions, {a: {x: 280, y: 70}, b: {x: 280, y: -42}}, '第一张底边贴父卡底边，往上排');
  assert.ok(up.positions.b.y + 72 <= up.positions.a.y - 40);
  assert.deepEqual(up.bounds, {x: 100, y: -42, w: 380, h: 198});
});

test('expandLayout：与 occupied 重叠时只沿纵向外推，不横向乱挪；父卡位置不变', () => {
  const parentRect = {x: 100, y: 100, w: 140, h: 56};
  const children = [{id: 'a', w: 200, h: 86}];
  const occupied = [{x: 280, y: 100, w: 200, h: 86}, {x: 280, y: 200, w: 200, h: 100}];
  const before = JSON.parse(JSON.stringify({parentRect, children, occupied}));
  const result = expandLayout({parentRect, children, occupied, dir: {x: 1, y: 1}, gap: 40});
  assert.equal(result.positions.a.x, 280, '横向固定在父卡右侧，不左右挪');
  assert.ok(result.positions.a.y >= 340, '越过两块 occupied：100→226→352');
  const childRect = {x: result.positions.a.x, y: result.positions.a.y, w: 200, h: 86};
  for (const rect of occupied) {
    const hit = childRect.x < rect.x + rect.w && rect.x < childRect.x + childRect.w && childRect.y < rect.y + rect.h && rect.y < childRect.y + childRect.h;
    assert.equal(hit, false, '子卡不得与 occupied 重叠');
  }
  assert.deepEqual(parentRect, before.parentRect);
  assert.deepEqual(children, before.children);
  assert.deepEqual(occupied, before.occupied);
  // occupied 不在这一列时不该影响位置。
  const clear = expandLayout({parentRect, children, occupied: [{x: 0, y: 0, w: 100, h: 100}], dir: {x: 1, y: 1}});
  assert.deepEqual(clear.positions, {a: {x: 280, y: 100}});
});

test('expandLayout：确定性（同输入同输出）、顺序按入参、空 children 返回父卡包围盒', () => {
  const payload = {
    parentRect: {x: 10, y: 20, w: 140, h: 56},
    children: [{id: 'b', w: 180, h: 72}, {id: 'a', w: 200, h: 86}],
    occupied: [{x: 190, y: 20, w: 200, h: 86}],
    dir: {x: 1, y: 1},
    gap: 40,
  };
  const first = expandLayout(payload);
  const second = expandLayout(payload);
  assert.deepEqual(first, second);
  // 顺序按入参：b 先排，a 被 occupied 推到后面。
  assert.ok(first.positions.b.y < first.positions.a.y);
  const none = expandLayout({parentRect: {x: 10, y: 20, w: 140, h: 56}, children: [], dir: {x: 1, y: 1}});
  assert.deepEqual(none.positions, {});
  assert.deepEqual(none.bounds, {x: 10, y: 20, w: 140, h: 56});
  // 缺参也不炸，返回可序列化结果。
  assert.deepEqual(expandLayout({}), {positions: {}, bounds: {x: 0, y: 0, w: 0, h: 0}});
});

// ---------------------------------------------------------------- fitRect

test('fitRect：空输入/无有效视口 → 安全默认', () => {
  assert.deepEqual(fitRect({rects: []}), {zoom: 1, gx: 20, gy: 20});
  assert.deepEqual(fitRect({}), {zoom: 1, gx: 20, gy: 20});
  assert.deepEqual(fitRect({rects: [{x: 0, y: 0, w: 100, h: 100}], viewport: {w: 0, h: 0}}), {zoom: 1, gx: 20, gy: 20});
  assert.deepEqual(fitRect({rects: [{x: 0, y: 0, w: 100, h: 100}], viewport: null}), {zoom: 1, gx: 20, gy: 20});
});

test('fitRect：内容放得下时居中且 zoom 不超过 1；全部矩形落在视口内', () => {
  const viewport = {w: 1000, h: 600};
  const single = fitRect({rects: [{x: 0, y: 0, w: 200, h: 100}], viewport, padding: 60});
  assert.deepEqual(single, {zoom: 1, gx: 400, gy: 250});
  // 宽度是约束边：1200 宽在 880 可用宽里 → 0.7333…
  const wide = fitRect({rects: [{x: 0, y: 0, w: 1200, h: 600}], viewport, padding: 60});
  assert.ok(wide.zoom >= 0.6 && wide.zoom <= 1.0, 'zoom 夹在 [0.6, 1.0]');
  assert.ok(Math.abs(wide.zoom - 880 / 1200) < 1e-9);
  const screen = (rect, result) => ({
    left: rect.x * result.zoom + result.gx,
    top: rect.y * result.zoom + result.gy,
    right: (rect.x + rect.w) * result.zoom + result.gx,
    bottom: (rect.y + rect.h) * result.zoom + result.gy,
  });
  for (const rect of [{x: 0, y: 0, w: 1200, h: 600}, {x: 100, y: 50, w: 500, h: 200}]) {
    const box = screen(rect, wide);
    assert.ok(box.left >= -1e-6 && box.top >= -1e-6 && box.right <= viewport.w + 1e-6 && box.bottom <= viewport.h + 1e-6, '矩形全在视口内');
  }
  // 多矩形取包围盒居中。
  const multi = fitRect({rects: [{x: 0, y: 0, w: 100, h: 100}, {x: 300, y: 200, w: 100, h: 100}], viewport, padding: 60});
  assert.deepEqual(multi, {zoom: 1, gx: 300, gy: 150});
});

test('fitRect：内容过大时 zoom 夹到 0.6，内容过小时夹到 1.0', () => {
  const viewport = {w: 1000, h: 600};
  const huge = fitRect({rects: [{x: 0, y: 0, w: 3000, h: 1500}], viewport});
  assert.equal(huge.zoom, 0.6, '不低于 0.6');
  const tiny = fitRect({rects: [{x: 0, y: 0, w: 10, h: 10}], viewport});
  assert.equal(tiny.zoom, 1, '不超过 1.0');
  // 任意矩形组合下 zoom 都夹在 [0.6, 1.0]，坐标有限。
  for (const size of [10, 100, 900, 2000, 8000]) {
    const result = fitRect({rects: [{x: -size, y: -size, w: size, h: size}], viewport});
    assert.ok(result.zoom >= 0.6 && result.zoom <= 1.0);
    assert.ok([result.zoom, result.gx, result.gy].every(Number.isFinite));
  }
});

// ---------------------------------------------------------------- semanticTier

test('semanticTier：阈值 0.6 / 1.1 与 space-view-v5 完全一致', () => {
  assert.equal(TIER_NAME_MAX, 0.6);
  assert.equal(TIER_RELATION_MIN, 1.1);
  assert.equal(semanticTier(0.59), 'name');
  assert.equal(semanticTier(0.6), 'status');
  assert.equal(semanticTier(0.6001), 'status');
  assert.equal(semanticTier(1.09), 'status');
  assert.equal(semanticTier(1.1), 'status');
  assert.equal(semanticTier(1.11), 'relation');
  assert.equal(semanticTier(0), 'name');
  assert.equal(semanticTier(2), 'relation');
});

test('semanticTier：与现有画布 nodeDetailAt/showsEdgeLabels 逐点一致（同一套阈值，不是两套）', () => {
  const sample = {kind: 'project', title: '项目', progress: {done: 1, total: 2}, businessStatus: 'todo'};
  for (const zoom of [0.3, 0.59, 0.6, 0.72, 1.09, 1.1, 1.11, 1.5]) {
    assert.equal(semanticTier(zoom) === 'name', nodeDetailAt(sample, zoom) === '项目', '名称层阈值必须相同：' + zoom);
    assert.equal(semanticTier(zoom) === 'relation', showsEdgeLabels(zoom), '关系文字阈值必须相同：' + zoom);
  }
});

// ---------------------------------------------------------------- roleVisual

test('roleVisual：只用 10 个已登记色 token、不写 hex、形状只有 5 种、index 循环稳定', () => {
  const allowed = new Set(['--pal-indigo', '--pal-teal', '--pal-cyan', '--pal-violet', '--pal-magenta', '--pal-pink', '--pal-orange', '--pal-slate', '--pal-gold', '--pal-lime']);
  assert.deepEqual([...PALETTE_TOKENS], [...allowed]);
  assert.deepEqual([...SHAPES], ['hexagon', 'diamond', 'square', 'circle', 'triangle']);
  const colors = new Set();
  const shapes = new Set();
  for (let index = 0; index < 10; index += 1) {
    const visual = roleVisual('角色' + index, index);
    assert.equal(visual.colorToken, PALETTE_TOKENS[index]);
    assert.ok(allowed.has(visual.colorToken), '颜色只能从登记调色板取');
    assert.match(visual.colorToken, /^--pal-[a-z]+$/, '颜色只写 token，不写 hex');
    assert.ok(SHAPES.includes(visual.shape));
    colors.add(visual.colorToken);
    if (index < 5) shapes.add(visual.shape);
    assert.deepEqual(roleVisual('角色' + index, index), visual, '同 index 同输出');
  }
  assert.equal(colors.size, 10, '10 个 token 循环用满');
  assert.equal(shapes.size, 5, '5 种形状循环用满');
  // 循环：index 10 回到 index 0；负数也落在合法下标上。
  assert.deepEqual(roleVisual('x', 10), roleVisual('x', 0));
  assert.deepEqual(roleVisual('x', 20), roleVisual('x', 0));
  const negative = roleVisual('x', -1);
  assert.ok(allowed.has(negative.colorToken) && SHAPES.includes(negative.shape));
  // 未分类/未归属固定灰色（问号语义由调用方加），代码里不出现色值。
  assert.deepEqual(UNCLASSIFIED_VISUAL, {colorToken: '--pal-slate', shape: 'circle'});
  assert.deepEqual(UNASSIGNED_VISUAL, {colorToken: '--pal-slate', shape: 'circle'});
});

// ---------------------------------------------------------------- capacityReport / 桶上限

test('classify 超过 10 类不丢数据；capacityReport 如实提示超限与聚合建议', () => {
  const nodes = Array.from({length: 12}, (_, index) => org('o' + index, '机构' + index, '自定角色' + index));
  const result = classify({nodes, scope: 'all'});
  assert.equal(result.buckets.length, 12, '12 个自定义角色 → 12 个桶，不合并、不丢');
  assert.deepEqual(result.buckets.map(bucket => bucket.label), Array.from({length: 12}, (_, index) => '自定角色' + index));
  assert.equal(result.buckets.reduce((sum, bucket) => sum + bucket.roleIds.length, 0), 12);
  const report = capacityReport({bucketCount: result.buckets.length, nodeCount: 1});
  assert.equal(report.overCap, true);
  assert.equal(typeof report.message, 'string');
  assert.ok(report.message.includes('12') && report.message.includes(String(MAX_ROLE_BUCKETS)), '文案要说清数字和建议上限');
});

test('capacityReport：≤10 类 / 单桶 ≤20 个机构不超限，超一个就如实提示', () => {
  assert.equal(MAX_ROLE_BUCKETS, 10);
  assert.equal(BUCKET_AGGREGATE_LIMIT, 20);
  assert.equal(capacityReport({bucketCount: 10, nodeCount: 20}).overCap, false);
  assert.equal(capacityReport({bucketCount: 0, nodeCount: 0}).overCap, false);
  assert.ok(capacityReport({bucketCount: 10, nodeCount: 20}).message.length > 0);
  const overBuckets = capacityReport({bucketCount: 11, nodeCount: 1});
  assert.equal(overBuckets.overCap, true);
  assert.ok(overBuckets.message.includes('11'));
  const overNodes = capacityReport({bucketCount: 1, nodeCount: 21});
  assert.equal(overNodes.overCap, true);
  assert.ok(overNodes.message.includes('21'));
  const both = capacityReport({bucketCount: 11, nodeCount: 21});
  assert.equal(both.overCap, true);
  assert.ok(both.message.includes('11') && both.message.includes('21'));
  assert.equal(capacityReport({}).overCap, false, '缺参安全');
});

// ---------------------------------------------------------------- 模块边界

test('纯函数模块：不碰 DOM、不出现 hex 色值、要求的导出都在', () => {
  const source = readFileSync(new URL('../prototype/ecosystem-layout.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bdocument\b/, '纯函数层不能碰 DOM');
  assert.doesNotMatch(source, /\bwindow\b/, '纯函数层不能碰 window');
  assert.doesNotMatch(source, /querySelector|createElement|getComputedStyle/, '纯函数层不能碰 DOM');
  assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, '颜色只写 --pal-* token，不写 hex');
  const api = {ROLE_LABELS, ROLE_KEYS, ROLE_TEMPLATES, roleOfOrg, roleOfParticipant, classify, childrenOf, expandState, outwardDir, expandLayout, fitRect, semanticTier, roleVisual, capacityReport};
  for (const [name, value] of Object.entries(api)) assert.ok(value !== undefined && value !== null, '缺少导出：' + name);
});
