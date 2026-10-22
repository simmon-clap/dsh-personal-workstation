import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, existsSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {WorkstationStore} from '../src/store.mjs';

/** 回滚证据（spec/53 §12 / 17 C 回滚 / spec/54 §7）：新增字段不能把旧版挡在门外。
 *
 *  能证明的三件事（都用真实代码跑，不靠说明）：
 *   ① 数据库结构没有变 —— 新字段全部存在 data JSON 里，旧版打开同一个库不会遇到未知列；
 *   ② 旧版（本机已安装的 3.9.x 包）**能读**含新字段的库，也能改没带新字段的旧记录；
 *   ③ 新版本能重新打开旧版写过的库。
 *
 *  本机没装包时如实 skip（不伪装通过）。 */
const installedStore = join(process.env.HOME ?? '', '.dsh/profiles/desktop/node_modules/dsh-personal-workstation/src/store.mjs');
const ctx = {workspace:'w', actor:'test', canWrite:true};

function schemaOf(path) {
  const db = new DatabaseSync(path, {readOnly:true});
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
    const columns = {};
    for (const table of tables) columns[table] = db.prepare('PRAGMA table_info(' + table + ')').all().map(row => row.name + ':' + row.type);
    return {tables, columns};
  } finally { db.close(); }
}

test('回滚：新字段不改变数据库结构（旧版不会遇到未知列）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rollback-schema-'));
  const fresh = new WorkstationStore(join(dir, 'db'));
  try {
    const schema = schemaOf(join(dir, 'db'));
    // 新字段（defaultRole / participants / roleTemplate / roleColors…）全部在 data JSON 里：
    // 表结构必须仍然是这几张表、这几列，没有新增列。
    assert.deepEqual(schema.tables, ['audit', 'batches', 'entities', 'receipts', 'sqlite_sequence', 'tombstones'].filter(name => schema.tables.includes(name)));
    assert.deepEqual(schema.columns.entities, ['workspace:TEXT', 'id:TEXT', 'kind:TEXT', 'revision:INTEGER', 'data:TEXT', 'archived:INTEGER', 'author:TEXT', 'at:TEXT']);
  } finally { fresh.close(); }
});

test('回滚：旧版能读含新字段的库；写入必须先还原备份（真实边界，不美化）', async t => {
  if (!existsSync(installedStore)) return t.skip('本机没有已安装包（' + installedStore + '），无法验证旧版兼容');
  // 2026-10-22：本机装的就是**当前版本**时，这个测试拿不到"旧版"——它会变成"用自己验证自己"，
  // 必然假红（实测：装上 3.10.0 后这里开始失败，测试本身没问题，是前提失效）。
  // 如实 skip，并写明该怎么补：要验证回滚，得指定一个真正的旧包。
  const installedVersion = JSON.parse(readFileSync(join(installedStore, '..', '..', 'package.json'), 'utf8')).version;
  const currentVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  if (installedVersion === currentVersion) {
    return t.skip('本机安装的就是当前版本 ' + currentVersion + '，没有"旧版"可比；回滚验证需要指定一个旧包（2026-10-22 如实跳过）');
  }
  const old = await import(pathToFileURL(installedStore).href);
  const OldStore = old.WorkstationStore;
  assert.equal(typeof OldStore, 'function', '已安装包应导出 WorkstationStore');
  const dir = mkdtempSync(join(tmpdir(), 'rollback-compat-'));
  const path = join(dir, 'db');

  // 用**当前代码**写一份带全部新字段的库（合成数据，不碰真实业务库）。
  const store = new WorkstationStore(path);
  try {
    const batch = store.draft(ctx, {title:'seed', changes:[
      {op:'create', id:'org-1', kind:'organization', data:{title:'机构甲', defaultRole:'客户'}},
      {op:'create', id:'p-1', kind:'project', data:{title:'项目一', roleTemplate:'delivery', organizationId:'org-1', participants:[{organizationId:'org-1', role:'客户'}]}},
      {op:'create', id:'t-1', kind:'task', data:{title:'旧形状任务', projectId:'p-1'}},
    ]});
    store.commit(ctx, {batchId:batch.id, revision:batch.revision, key:'seed'});
    const layout = store.draft(ctx, {title:'layout', changes:[{op:'create', id:'layout-eco', kind:'layout', data:{positions:{}, viewport:{x:0,y:0,zoom:1}, roleColors:{客户:'--pal-gold'}, roleShapes:{客户:'diamond'}, order:['客户']}}]});
    store.commit(ctx, {batchId:layout.id, revision:layout.revision, key:'layout'});
  } finally { store.close(); }

  // 旧版打开同一个库：能读、数据不丢、可改旧记录。
  const legacy = new OldStore(path);
  try {
    const items = legacy.list(ctx, {limit:50});
    assert(items.length >= 3, '旧版应能列出新库里的对象');
    const project = legacy.get(ctx, 'p-1');
    assert.equal(project.data.title, '项目一');
    assert.equal(project.data.participants[0].role, '客户', '新字段在旧版里仍是数据（读得到、不崩）');
    const org = legacy.get(ctx, 'org-1');
    assert.equal(org.data.defaultRole, '客户');
    // 写入边界（如实记录，不美化）：旧版的提交会**校验库里所有实体**，它的校验器不认识新字段，
    // 所以只要库里还有带新字段的记录，旧版任何提交都会被拒。这就是回滚必须「先还原备份 / 先清掉新字段」
    // 的原因（spec/53 §12 回滚方案：备份可还原；不是"旧包直接就能接着用"）。
    const draft = legacy.draft(ctx, {title:'旧版改任务', changes:[{op:'update', id:'t-1', expectedRevision:1, data:{title:'旧版改过的任务', projectId:'p-1'}}]});
    assert.throws(() => legacy.commit(ctx, {batchId:draft.id, revision:draft.revision, key:'legacy-write'}), /未知或受保护字段/,
      '旧版在含新字段的库上写不了 —— 这是真实边界，回滚必须先还原备份或清掉新字段');
  } finally { legacy.close(); }

  // 旧版本身没问题：换一份**没有新字段**的库，它能正常写（证明限制来自新字段的记录，不是包坏了）。
  const plainPath = join(dir, 'plain');
  const plain = new WorkstationStore(plainPath);
  try {
    const batch = plain.draft(ctx, {title:'seed', changes:[{op:'create', id:'t-old', kind:'task', data:{title:'旧记录'}}]});
    plain.commit(ctx, {batchId:batch.id, revision:batch.revision, key:'seed-plain'});
  } finally { plain.close(); }
  const legacyPlain = new OldStore(plainPath);
  try {
    const draft = legacyPlain.draft(ctx, {title:'旧版改任务', changes:[{op:'update', id:'t-old', expectedRevision:1, data:{title:'旧版改过的任务'}}]});
    legacyPlain.commit(ctx, {batchId:draft.id, revision:draft.revision, key:'legacy-write-plain'});
    assert.equal(legacyPlain.get(ctx, 't-old').data.title, '旧版改过的任务');
  } finally { legacyPlain.close(); }

  // 新版本重新打开（旧版读过的）库：结构与数据都在。
  const reopened = new WorkstationStore(path);
  try {
    assert.equal(reopened.get(ctx, 't-1').data.title, '旧形状任务','被旧版拒绝的写入不应半途改掉数据');
    assert.equal(reopened.get(ctx, 'p-1').data.organizationId, 'org-1');
  } finally { reopened.close(); }
});
