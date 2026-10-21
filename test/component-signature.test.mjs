import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  CLEAN_TABLE,
  INJECTIONS,
  RULES,
  applyInjection,
  formatJson,
  formatText,
  loadRepoFiles,
  runRules,
  selfTest,
} from '../prototype/component-signature-audit.mjs';

/**
 * 共享组件签名门禁的纯函数回归（B0）。
 *
 * 三类断言：
 * 1) canary：干净样本 8/8 规则 0 违规；每条规则注入一处违规必红。
 *    这是 17 C3「不许假绿」的最低要求——没有 canary 的门禁只是一段愿望。
 * 2) 规则元信息：8 条规则都有 id/要求/违规样本/依据，且都能被 self-test 跑到。
 * 3) 真实仓库结论：**如实报告**。当前仓库有 B1/B2/B3/A2/B4 才修的已知违例，
 *    所以这里断言「审计现在是红的」，并把每个真实违例的归属批次钉住；
 *    不预设「必须全绿」，也绝不为了绿放宽规则。后续批次修完后，
 *    请同步更新 BASELINE 并在 spec/56 记一笔（不要删断言）。
 */

test('canary：干净样本 8/8 规则 0 违规，退出码 0', () => {
  const report = runRules(CLEAN_TABLE);
  assert.equal(report.rules.length, 8, '规则数必须是 8');
  assert.deepEqual(report.rules.map(rule => rule.id), RULES.map(rule => rule.id));
  assert.equal(report.summary.findings, 0, '干净样本不允许有任何 finding');
  assert.equal(report.summary.fail, 0);
  assert.equal(report.exitCode, 0);
  assert.equal(report.ok, true);
});

test('canary：每条规则注入一处违规必红（8/8）', () => {
  const clean = runRules(CLEAN_TABLE);
  assert.equal(clean.summary.findings, 0, '注入前基线必须是 0');
  assert.equal(INJECTIONS.length, RULES.length, '每条规则都必须有 canary，不能漏');
  for (const injection of INJECTIONS) {
    const report = runRules(applyInjection(injection));
    const target = report.rules.find(rule => rule.id === injection.ruleId);
    const others = report.rules.filter(rule => rule.id !== injection.ruleId);
    assert.ok(target, `规则 ${injection.ruleId} 不存在`);
    assert.equal(target.status, 'fail', `注入「${injection.name}」后 ${injection.ruleId} 必须红`);
    assert.ok(target.findings.length > 0, `注入「${injection.name}」必须产生至少一处违例`);
    assert.ok(
      target.findings.some(finding => finding.category === injection.expectCategory),
      `注入「${injection.name}」的分类应为 ${injection.expectCategory}，实际 ${JSON.stringify(target.findings.map(finding => finding.category))}`,
    );
    assert.ok(target.findings.every(finding => typeof finding.path === 'string' && Number.isInteger(finding.line) && finding.line >= 0), '违例必须带文件:行');
    assert.ok(others.every(rule => rule.status === 'pass'), `注入「${injection.name}」不应污染其它规则：${others.filter(rule => rule.status !== 'pass').map(rule => rule.id).join(',')}`);
  }
});

test('canary：--self-test 入口整体通过（干净 0 + 8 处注入必红 = 9/9）', () => {
  const result = selfTest();
  assert.equal(result.ok, true);
  assert.equal(result.cases.length, 9);
  assert.equal(result.cases.filter(item => item.ok).length, 9);
});

test('门禁质量：8 条规则都有要求、违规样本与依据，且违规样本能被对应规则抓到', () => {
  assert.equal(RULES.length, 8);
  for (const rule of RULES) {
    assert.ok(rule.id && rule.title, '规则必须有 id 与标题');
    assert.ok(rule.requirement.length > 10, `${rule.id} 缺要求说明`);
    assert.ok(rule.violationSample.length > 3, `${rule.id} 缺违规样本`);
    assert.ok(rule.source.includes('spec/'), `${rule.id} 缺依据`);
  }
});

test('真实仓库：当前结论被如实报告（收口后全绿，且断言仍然不是空跑）', () => {
  const loaded = loadRepoFiles();
  const report = runRules(loaded);
  const byId = Object.fromEntries(report.rules.map(rule => [rule.id, rule]));

  // registry 的实测口径：脚本读不到/未登记时，规则 7 必须是 unregistered，而不是崩溃或假绿。
  const registered = Boolean(
    loaded.registry
    && !loaded.registry.error
    && (loaded.registry.components?.items ?? []).some(item => item?.id === 'card' && (item.variants ?? []).includes('canvasNode')),
  );

  /** B0 写稿时的真实结论（2026-10-21）。后续批次修复后更新本表，不要放宽规则。 */
  const BASELINE = {
    // 2026-10-21 B1/B3 收口后：命令面板已登记为独立搜索浮层；520 死声明删除；510 死声明在生成期收敛成 760；
    // 收件箱自造空态改走 empty-state.mjs。现在 8 条规则应当全绿（规则与 canary 没有放宽）。
    'dialog-unique': {status: 'pass'},
    'dialog-width': {status: 'pass'},
    'undo-feedback': {status: 'pass'},
    'empty-state': {status: 'pass'},
    'status-dot': {status: 'pass'},
    'filter-bar': {status: 'pass'},
    'card-shell': {status: 'pass'},
    'canvas-node-variant': registered ? {status: 'pass'} : {status: 'fail', category: 'unregistered', fix: 'A0'},
  };

  for (const [id, expected] of Object.entries(BASELINE)) {
    const rule = byId[id];
    assert.ok(rule, `真实审计缺少规则 ${id}`);
    assert.equal(rule.status, expected.status, `${id} 的真实结论与基线不符（若刚修完，请更新 BASELINE 并记录，不要放宽规则）`);
    if (expected.paths) {
      const paths = rule.findings.map(finding => finding.path);
      for (const path of expected.paths) assert.ok(paths.includes(path), `${id} 应报出 ${path}，实际 ${JSON.stringify(paths)}`);
    }
    if (expected.category) {
      assert.ok(rule.findings.some(finding => finding.category === expected.category), `${id} 应报 category=${expected.category}`);
    }
    if (expected.fix && rule.findings.length) {
      assert.ok(rule.findings.every(finding => Boolean(finding.expectedFix)), `${id} 的已知违例必须写清修复批次`);
    }
  }

  // B1/B3 收口后应当全绿；但 must not be vacuous：canary 已经证明注入违规会红。
  assert.equal(report.ok, registered, '修完后应当全绿；未登记 canvasNode 时仍应红');
  assert.equal(report.exitCode, registered ? 0 : 1);
  assert.equal(report.summary.unregistered, registered ? 0 : report.summary.unregistered);

  // 逐条违例必须可定点（文件:行），不能只有一句"存在违例"。
  for (const rule of report.rules) {
    for (const finding of rule.findings) {
      assert.ok(finding.path.startsWith('prototype/'), `违例路径应为 prototype/ 相对路径：${finding.path}`);
      assert.ok(Number.isInteger(finding.line) && finding.line >= 1, `违例必须带行号：${JSON.stringify(finding)}`);
      assert.ok(['pending-rework', 'violation', 'unregistered'].includes(finding.category), `未知分类：${finding.category}`);
      assert.ok(finding.note && finding.note.length > 5, '违例必须说明原因');
    }
  }

  // 收口后应无真实违例可指：命令面板、旧宽度、收件箱空态都已按规范处理。
  const flat = report.rules.flatMap(rule => rule.findings);
  assert.deepEqual(flat, [], '收口后不应再有真实违例：' + JSON.stringify(flat));
});

test('输出格式：文本逐条 PASS/FAIL；--json 是合法 JSON 且与报告同源', () => {
  const loaded = loadRepoFiles();
  const report = runRules(loaded);
  const text = formatText(report, {scanned: loaded.scanned});
  // 收口后全绿：文本里每条都应是 PASS，并且必须给出退出码结论（0）。
  // 「有违规时会不会打出 FAIL」由 canary 测试证明（注入必红），不靠这一条在当前状态上碰运气。
  assert.ok(text.includes('PASS'), '文本输出必须逐条给 PASS');
  assert.ok(text.includes('退出码 0'), '文本输出必须给退出码结论');
  assert.equal(report.exitCode, 0, '收口后应当 0 退出');

  const parsed = JSON.parse(formatJson(report, {scanned: loaded.scanned}));
  assert.equal(parsed.ok, report.ok);
  assert.equal(parsed.exitCode, report.exitCode);
  assert.deepEqual(parsed.summary, report.summary);
  assert.equal(parsed.rules.length, 8);
  assert.ok(parsed.rules.every(rule => rule.status === 'pass' || rule.status === 'fail'));
});
