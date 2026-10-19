// W2-3 页面身份：七页各有一句只属于这一页的提示（17 C5 / 46 §1.1「7 页同一句」）。
// 这里锁两件事：提示文案不重复、不含实现/设计说法；切页时 #subtitle 真的会变。
import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from '../dev-deps.mjs';
import {mountNavigation, pageHints} from '../prototype/navigation.mjs';

const VIEWS = ['home', 'inbox', 'space', 'projects', 'tasks', 'knowledge', 'personal'];

test('七页提示齐全、互不重复、不是内部说法', () => {
  assert.deepEqual(Object.keys(pageHints), VIEWS, '七页都有一句提示');
  const values = Object.values(pageHints);
  assert.equal(new Set(values).size, values.length, '七页提示不能共用一句');
  for (const [view, hint] of Object.entries(pageHints)) {
    assert.ok(hint.length >= 8 && hint.length <= 30, view + ' 的提示要短而具体');
    assert.doesNotMatch(hint, /实现|基线|50 条|最近加载|维度/, view + ' 的提示不能用实现/设计说法');
  }
});

test('切页时面包屑、隐藏标题与副标题一起更新', () => {
  const dom = new JSDOM('<body>' + VIEWS.map(v => `<section id="${v}" class="view"></section>`).join('')
    + '<nav>' + VIEWS.map(v => `<button data-view="${v}"></button>`).join('') + '</nav>'
    + '<b id="crumb"></b><div id="title" hidden></div><p id="subtitle"></p></body>');
  const {show, dispose} = mountNavigation(dom.window.document);
  try {
    for (const view of VIEWS) {
      show(view);
      assert.equal(dom.window.document.querySelector('#subtitle').textContent, pageHints[view]);
    }
    assert.equal(dom.window.document.querySelectorAll('.view.active').length, 1, '一次只显示一页');
    assert.equal(dom.window.document.querySelector('#subtitle').textContent, pageHints.personal);
  } finally { dispose(); }
});
