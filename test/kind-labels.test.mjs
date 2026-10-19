/** 每个对象类型都必须有中文标签（防"英文 kind 漏到界面"）。
 *
 *  为什么单独立一条：判断（judgment）上线之后，`find.mjs` / `inbox.mjs` / `space-view.mjs`
 *  三张映射表都**漏了它** —— 于是判断在搜索结果、收件箱卡片、画布节点上会显示成英文 `judgment`。
 *  这正是用户 2026-10-12 投诉过的那一类（"值要翻译"），而且**没有任何门禁在管**。
 *
 *  判据：源码里每一张 `kindLabels={...}` 映射表，都必须覆盖 store 认可的全部对象类型
 *  （`layout`/`relation` 是内部对象，允许不出现在界面映射里）。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join, dirname, basename} from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const storeSource = readFileSync(join(root, 'src', 'store.mjs'), 'utf8');
const kinds = [...(/const kinds = new Set\(\[([^\]]*)\]\)/.exec(storeSource)[1].matchAll(/'([^']+)'/g))].map(m => m[1]);
/** 面向用户的对象类型：会出现在列表 / 画布 / 搜索里的那些。 */
const USER_FACING = ['project', 'task', 'artifact', 'topic', 'event', 'organization', 'person', 'memoryRef', 'judgment'];
/** 不进界面映射表的类型，各有明确理由（写在这里，不靠"登记即合法"的豁免表）：
 *  · relation / layout：内部对象，界面另有专门呈现（关系列表 / 画布布局）；
 *  · proposal / brief：目前**不作为对象出现** —— 建议是批次上的字段、简报是即时聚合（真实库里两者都是 0 行）。
 *    一旦它们开始作为对象出现在界面上，这份清单要跟着改（这个测试的失败会提醒你）。 */
const NOT_ON_SCREEN = new Set(['relation', 'layout', 'proposal', 'brief']);
/** 只处理部分类型的小表单（收件箱里的"录入"只认资料/议题），允许它只覆盖自己那几个。 */
const PARTIAL_FORMS = new Set(['intake.mjs']);

test('store 认可的对象类型至少覆盖到判断（这份清单变了要一起改）', () => {
  assert.ok(kinds.includes('judgment'), 'store 里应当有 judgment');
  assert.ok(kinds.length >= 10, '对象类型数量看起来不对：' + kinds.join(','));
});

test('每一张 kindLabels 映射表都覆盖了面向用户的对象类型', () => {
  const problems = [];
  for (const name of readdirSync(join(root, 'prototype')).filter(n => n.endsWith('.mjs'))) {
    const source = readFileSync(join(root, 'prototype', name), 'utf8');
    for (const match of source.matchAll(/kindLabels\s*=\s*\{([^}]*)\}/g)) {
      const keys = new Set([...match[1].matchAll(/([A-Za-z]+)\s*:/g)].map(m => m[1]));
      if (PARTIAL_FORMS.has(name)) {
        // 局部表单：只要求"它写进去的键都是面向用户的"（别把内部类型摆给用户）。
        for (const key of keys) {
          if (!USER_FACING.includes(key)) problems.push(basename(name) + ' 的映射表出现了不该给用户看的类型 ' + key);
        }
        continue;
      }
      for (const kind of USER_FACING) {
        if (!keys.has(kind)) problems.push(basename(name) + ' 的映射表缺少 ' + kind);
      }
    }
  }
  assert.deepEqual(problems, [], '有映射表漏了对象类型 —— 界面上会显示成英文 kind：\n  ' + problems.join('\n  '));
});

test('例外清单里的类型确实不该出现在界面上（防止有人顺手把它加进豁免）', () => {
  for (const kind of NOT_ON_SCREEN) {
    assert.ok(kinds.includes(kind), kind + ' 已经不在 store 的对象类型里了 —— 例外清单该删掉');
    assert.ok(!USER_FACING.includes(kind), kind + ' 同时在例外清单与面向用户清单里，矛盾');
  }
});
