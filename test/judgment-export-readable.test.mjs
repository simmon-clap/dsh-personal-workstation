/** 判据 6「一条判断能被另一个需要它的人直接拿走用」（2026-10-16 首次真实验收）。
 *
 *  验收方法：拿**真实库里的判断**生成文档，然后**站在"没有工作台的读者"角度**读它。
 *  第一次的真实结果是**不通过**，三处都把内部编号摆给了读者：
 *    · 谁在何时判断：`operator:407457ca-a50f-4b22-9f82-5faafa9767ec`（UUID，不是人）
 *    · 出处：`art-example-minutes-20261011`（内部编号，不知道是什么）
 *    · 记录时间：`2026-10-16T07:00:16.852Z`（机器时间戳）
 *  这正是用户反复强调的那条铁律：**值要翻译，不许把内部编号摆给用户看**。
 *
 *  这里守住三件事：作者说人话、出处能解析成标题（解析不到也不退回裸编号）、时间说人话，
 *  并且**整篇文档里不得出现 UUID 或内部编号**。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {judgmentDocument, humanAuthor, humanRef, humanTime, exportPreview} from '../prototype/judgment-export.mjs';

const UUID = '407457ca-a50f-4b22-9f82-5faafa9767ec';
const item = overrides => ({
  id: 'j-1', kind: 'judgment', author: `operator:${UUID}`, at: '2026-10-16T07:00:16.852Z',
  data: {
    title: '当前方案与时间安排尚未确认', share: 'team', status: 'checking',
    validFrom: '2026-10-11', uncertainty: '时间点是对方口述的排期，没有任何书面材料。',
    evidence: [{kind: 'file', ref: 'art-example-minutes-20261011', quote: '示例依据：方案参数与时间安排仍需核对', verified: false}],
    ...overrides,
  },
});

test('作者：说人话，绝不摆 UUID', () => {
  assert.equal(humanAuthor(`operator:${UUID}`), '本工作台的操作者');
  assert.equal(humanAuthor('agent:s-1'), '工作台的助理（AI）');
  assert.equal(humanAuthor(UUID), '未记录', '认不出是谁时宁可说"未记录"，也不摆一串编号');
  assert.equal(humanAuthor(undefined), '未记录');
});

test('出处：能解析成标题就用标题；解析不到也不退回裸编号', () => {
  assert.equal(humanRef('art-1', () => '会议纪要 · 示例产品'), '会议纪要 · 示例产品');
  assert.doesNotMatch(humanRef('art-example-minutes-20261011', null), /art-example/, '解析不到时不许把编号摆出来');
  assert.match(humanRef('file.md@12-40', null), /第 12–40 段/, '带段落范围的出处要保留"哪一段"这个有用信息');
});

test('时间：说人话（不带毫秒与时区后缀）', () => {
  assert.match(humanTime('2026-10-16T07:00:16.852Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.doesNotMatch(humanTime('2026-10-16T07:00:16.852Z'), /T|Z|\./);
});

test('整篇文档不得出现 UUID 或内部编号（站到"别人"的角度读）', () => {
  const items = [item({}), item({title: '仅自己的那条', share: 'private'})];
  const doc = judgmentDocument(items, {at: '2026-10-16T14:40:00Z', resolve: () => '会议纪要 · 示例产品'});
  assert.doesNotMatch(doc, new RegExp(UUID), '文档里不许出现操作者 UUID');
  assert.doesNotMatch(doc, /\b(?:j|proj|art|ev|topic|task|rel|voice)-[a-z0-9-]{4,}/i, '文档里不许出现内部编号');
  assert.match(doc, /已剔除 1 条标为「仅自己」的判断/, '剔除项必须明示（分享默认仅自己）');
  assert.match(doc, /共 1 条/);
});

test('没有人标「可以给同事看」时，文档要说明而不是空着', () => {
  const doc = judgmentDocument([item({share: 'private'})], {at: '2026-10-16T14:40:00Z'});
  assert.match(doc, /没有可以分享的判断/);
  assert.deepEqual(exportPreview([item({share: 'private'})]), {shared: 0, excluded: 1, total: 1});
});

test('引用锚点里的"哪一段"不能在导出时丢掉（判据 3：追回**那一段**）', () => {
  // 实测过的真缺口：有了解析出来的标题之后，范围被覆盖掉了 ——
  // 读者只看到"某份录音"，还是追不回具体位置。
  const resolved = () => '会议录音 2026-10-11';
  assert.match(humanRef('art-1@120-180', resolved, 'audio'), /第 120–180 秒/, '录音按规范写"时间区间（秒）"');
  assert.match(humanRef('art-1@12-40', resolved, 'file'), /第 12–40 段/, '文件按"哪一段"写');
  assert.match(humanRef('art-1@12-40', resolved, 'file'), /会议录音 2026-10-11/, '标题与范围都要有，不能二选一');
  // 没有范围时不许凭空加
  assert.doesNotMatch(humanRef('art-1', resolved, 'file'), /第 \d+/, '没写范围就不要造一个');
});

test('导出文档里也必须带着"哪一段"（不是只在函数里对）', () => {
  const item = {
    id: 'j-2', kind: 'judgment', author: 'operator:x', at: '2026-10-16T07:00:00.000Z',
    data: {
      title: '一条判断', share: 'team', status: 'checking', uncertainty: '未核实',
      evidence: [{kind: 'audio', ref: 'art-1@120-180', quote: '原话', verified: false}],
    },
  };
  const doc = judgmentDocument([item], {at: '2026-10-16T14:40:00Z', resolve: () => '会议录音 2026-10-11'});
  assert.match(doc, /第 120–180 秒/, '导出文档要能让别人定位到那一段');
});
