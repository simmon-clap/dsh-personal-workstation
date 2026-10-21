import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {scan, collectFiles, ruleBook, checkBannedTerms, checkDemoLeak, checkProductName, DEMO_MARKER} from '../prototype/positioning-check.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const registry = JSON.parse(readFileSync(join(root, '..', 'spec', 'registry.json'), 'utf8'));
const book = ruleBook(registry);

test('定位门禁口径来自登记表：词表非空、产品名是关联空间', () => {
  assert(book.bannedTerms.length >= 1, 'registry.positioning.bannedTerms 不能为空');
  assert.match(book.productName, /关联空间/);
  assert.throws(() => ruleBook({}), /positioning 段/);
  assert.throws(() => ruleBook({positioning: {bannedTerms: []}}), /词表缺失/);
});

test('干净样本 0 违规（不误报）', () => {
  const report = scan({
    files: [{path: 'src/a.mjs', content: "export const label='关联空间';"}, {path: 'src/v7-shell.html', content: '<button>关联空间</button>'}],
    bannedTerms: book.bannedTerms,
    productName: book.productName,
  });
  assert.equal(report.total, 0);
});

test('每个登记专用词出现在产品表面都必须被抓到（3/3 canary）', () => {
  for (const term of book.bannedTerms) {
    const report = scan({
      files: [{path: 'src/leak.mjs', content: "const x='" + term + "';"}, {path: 'src/v7-shell.html', content: '<button>关联空间</button>'}],
      bannedTerms: book.bannedTerms,
      productName: book.productName,
    });
    const rule = report.rules.find(item => item.id === 'bannedTerms');
    // 词之间有包含关系（例如「天宽」是「天宽生态」的前缀），同一行命中两条是如实计数，不是重复。
    assert(rule.count >= 1, '专用词没被抓到：' + term);
    assert(rule.violations.some(item => item.term === term), '命中的词里没有：' + term);
    assert(rule.violations.every(item => item.file === 'src/leak.mjs' && item.line === 1));
  }
});

test('产品代码引用演示目录 = 违规', () => {
  const clean = checkDemoLeak([{path: 'src/a.mjs', content: 'export const a=1;'}]);
  assert.equal(clean.count, 0);
  const dirty = checkDemoLeak([{path: 'src/a.mjs', content: "import x from '../../spec/" + DEMO_MARKER + "/a.mjs';"}]);
  assert.equal(dirty.count, 1);
  assert.equal(dirty.violations[0].rule, 'demoLeak');
});

test('画布产品名是正断言：外壳里没有「关联空间」即失败', () => {
  assert.equal(checkProductName([{path: 'src/v7-shell.html', content: '<button>关联空间</button>'}], book.productName).count, 0);
  assert.equal(checkProductName([{path: 'src/v7-shell.html', content: '<button>画布</button>'}], book.productName).count, 1);
  const missing = checkProductName([], book.productName);
  assert.equal(missing.count, 0);
  assert.match(missing.skipped, /v7-shell/);
});

test('白名单文件不扫描：测试夹具/证据截图/验收工具不进产品表面', () => {
  const files = collectFiles();
  assert(files.length > 0, '应扫到真实产品文件');
  assert(!files.some(file => file.path.startsWith('test/')), 'test/ 是夹具，不该扫');
  assert(!files.some(file => file.path.startsWith('prototype/screenshots/')), '证据截图不该扫');
  assert(!files.some(file => file.path.startsWith('releases/')), '发布包不该扫');
});

test('当前仓库真实结论如实报告（现在是 0 处；变红要能说清在哪）', () => {
  const report = scan({files: collectFiles(), bannedTerms: book.bannedTerms, productName: book.productName});
  assert.equal(report.total, 0, '真实违规：' + JSON.stringify(report.rules.flatMap(rule => rule.violations)));
});
