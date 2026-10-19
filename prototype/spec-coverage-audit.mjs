/** 规范覆盖门禁：**防止"加了规范却没人管"**。
 *
 *  起因（用户 2026-10-15）：「还是要反复检查和宪章、VI 规范、功能规范、交互规范是不是严格保持一致的，
 *  千万不要偏移」。靠人每次肉眼对，一定会漂 —— 所以要变成机器能查的东西。
 *
 *  做法：
 *    ① 从四份规范里**自动抽出所有条款**（新增一条就自动进入对照表）；
 *    ② `spec/coverage.json` 为每条声明：由哪道门禁保证，或**明确写明靠人工看什么**；
 *    ③ 本门禁检查三件事：
 *       · 有没有条款**既没门禁也没人工说明**（留白 = 没人管）→ 红
 *       · 声明的门禁**是否存在、是否真的在 verify 链里跑**（写了个不存在的门禁 = 假安心）→ 红
 *       · 声明靠人工的，**理由不能是空话**（"人工检查"这种等于没写）→ 红
 *
 *  它保证不了"门禁本身判得对"—— 那是各道门禁自己的责任。
 *  但它能保证一件更重要的事：**没有任何一条规范是悄悄没人管的**。
 *
 *  用法：node prototype/spec-coverage-audit.mjs
 */
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const spec = join(root, '..', 'spec');

const FILES = {
  '宪章': '01-顶层宪章-v1.0.md',
  'VI': '02-VI规范-v1.0.md',
  '功能': '03-功能与交互设计-v1.0.md',
  '约束': '04-开发规划与约束-v1.0.md',
};

/** 空话黑名单：这些写法等于没写。 */
const EMPTY_REASONS = /^(人工|人工检查|人工看|待补|待分类|暂无|无|n\/a|—|-)?$/i;
/** verify 链里实际跑的门禁。
 *  2026-10-16 修：原来 grep 的是**整份 package.json** —— 于是 `verify:craft`、`verify:ux`、`audit:interaction`
 *  这类"单独入口脚本"也被算成"在 verify 里跑"，而 `verify-v7.mjs` 又因正则不含数字被漏掉（既过宽又过窄）。
 *  现在只解析 `scripts.verify` 这一段，并且允许名字里有数字。 */
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const verifyScript = manifest?.scripts?.verify ?? '';
if (!verifyScript) {
  console.log('FAIL: package.json 里没有 scripts.verify —— 无法判断门禁到底跑没跑。');
  process.exit(1);
}
const runGates = new Set([...verifyScript.matchAll(/prototype\/([a-z0-9-]+)\.mjs/g)].map(m => m[1] + '.mjs'));
const allGates = new Set(readdirSync(here).filter(name => name.endsWith('.mjs')));
// 2026-10-16：很多条款其实是**单元测试**在管（例如"被否决的建议不复活"）。
// 只认 prototype/ 会把它们判成"没有门禁"，于是对照表只能写"靠人工" —— 那是不准确的。
// 这里把 test/*.test.mjs 也算作门禁：它们确实跑在 verify 链里（npm test 那一环）。
const testDir = join(here, '..', 'test');
const testGates = new Set(existsSync(testDir) ? readdirSync(testDir).filter(name => name.endsWith('.test.mjs')).map(name => 'test/' + name) : []);

const problems = [];
const coveragePath = join(spec, 'coverage.json');
if (!existsSync(coveragePath)) {
  console.log('FAIL: 缺少 spec/coverage.json —— 没有对照表就无法判断"规范有没有人管"。');
  process.exit(1);
}
const coverage = JSON.parse(readFileSync(coveragePath, 'utf8'));

let total = 0, gated = 0, human = 0;
for (const [label, file] of Object.entries(FILES)) {
  const text = readFileSync(join(spec, file), 'utf8');
  const clauses = [];
  for (const match of text.matchAll(/^#{2,3}\s+(.+)$/gm)) {
    const title = match[1].trim();
    if (['修订记录', '前言', '序'].includes(title)) continue;
    clauses.push(title);
  }
  const table = coverage[label] ?? {};
  for (const clause of clauses) {
    total += 1;
    const entry = table[clause];
    if (!entry) {
      problems.push(`${label} · 「${clause}」不在对照表里 —— 新增条款必须立刻声明由谁保证`);
      continue;
    }
    if (entry.unclassified) {
      problems.push(`${label} · 「${clause}」还是待分类 —— 留白等于没人管`);
      continue;
    }
    if (entry.gate) {
      gated += 1;
      // 一条声明可以挂多道门禁（用 + 分隔）；每一道都必须真的存在、且真的在跑。
      // 2026-10-16：还支持 `文件.mjs#断言原文` —— 那样就不只是"有人认领"，
      // 而是**能到门禁源码里核对这条断言真的存在**（找不到即失败）。
      for (const raw of String(entry.gate).split('+').map(x => x.trim()).filter(Boolean)) {
        const [name, assertion] = raw.split('#');
        const file = name.endsWith('.mjs') ? name : name + '.mjs';
        const isTest = file.startsWith('test/');
        if (isTest) {
          if (!testGates.has(file)) { problems.push(`${label} · 「${clause}」声明的测试不存在：${name}`); continue; }
          if (assertion) {
            let body = '';
            try { body = readFileSync(join(here, '..', file), 'utf8'); } catch { body = ''; }
            if (!body.includes(assertion)) problems.push(`${label} · 「${clause}」声明的用例在 ${name} 里找不到：${assertion}`);
          }
          continue;
        }
        if (!allGates.has(file)) { problems.push(`${label} · 「${clause}」声明的门禁不存在：${name}`); continue; }
        if (!runGates.has(file)) { problems.push(`${label} · 「${clause}」声明的门禁没在 verify 链里跑：${name}（写了却不跑＝假安心）`); continue; }
        if (assertion) {
          let body = '';
          try { body = readFileSync(join(here, file), 'utf8'); } catch { body = ''; }
          if (!body.includes(assertion)) {
            problems.push(`${label} · 「${clause}」声明的断言在 ${name} 里找不到：${assertion}（声称被它管着，实际没有）`);
          }
        }
      }
      continue;
    }
    if (entry.human !== undefined) {
      human += 1;
      if (EMPTY_REASONS.test(String(entry.human).trim())) {
        problems.push(`${label} · 「${clause}」标成靠人工，但没写"人工看什么" —— 等于没写`);
      }
      continue;
    }
    problems.push(`${label} · 「${clause}」的对照项既不是门禁也不是人工说明`);
  }
}

// ── 条级对照（2026-10-16 加）────────────────────────────────────────────────
// 标题级"有人认领"是不够的：实测出现过"十二条交互律里有 6 条**没有任何门禁点名**"照样通过。
// 所以条级条目逐条指到真实判据/断言，并到门禁源码里核对（找不到即失败）。
const TIER = coverage['条级']?.items ?? {};
let tierChecked = 0;
for (const [clause, entry] of Object.entries(TIER)) {
  tierChecked += 1;
  if (!entry || typeof entry !== 'object') { problems.push(`条级 · 「${clause}」的对照项格式不对`); continue; }
  if (entry.gate) {
    for (const raw of String(entry.gate).split('+').map(x => x.trim()).filter(Boolean)) {
      const [name, assertion] = raw.split('#');
      const file = name.endsWith('.mjs') ? name : name + '.mjs';
      const isTest = file.startsWith('test/');
      if (isTest) {
        if (!testGates.has(file)) { problems.push(`条级 · 「${clause}」声明的测试不存在：${name}`); continue; }
        if (!assertion) { problems.push(`条级 · 「${clause}」只写了测试名、没写是哪条用例`); continue; }
        let body = '';
        try { body = readFileSync(join(here, '..', file), 'utf8'); } catch { body = ''; }
        if (!body.includes(assertion)) problems.push(`条级 · 「${clause}」声明的用例在 ${name} 里找不到：${assertion}`);
        continue;
      }
      if (!allGates.has(file)) { problems.push(`条级 · 「${clause}」声明的门禁不存在：${name}`); continue; }
      if (!runGates.has(file)) { problems.push(`条级 · 「${clause}」声明的门禁没在 verify 链里跑：${name}`); continue; }
      if (!assertion) { problems.push(`条级 · 「${clause}」只写了门禁名、没写是哪条断言 —— 等于"有人认领"而不是"被管着"`); continue; }
      let body = '';
      try { body = readFileSync(join(here, file), 'utf8'); } catch { body = ''; }
      if (!body.includes(assertion)) problems.push(`条级 · 「${clause}」声明的断言在 ${name} 里找不到：${assertion}`);
    }
    continue;
  }
  if (entry.human !== undefined) {
    if (EMPTY_REASONS.test(String(entry.human).trim())) problems.push(`条级 · 「${clause}」标成靠人工，但没写"人工看什么"`);
    continue;
  }
  problems.push(`条级 · 「${clause}」既不是门禁也不是人工说明`);
}

// 反向：对照表里有、规范里已经没有的条款（规范删了条款，表里还留着 → 表会腐烂）
for (const [label, table] of Object.entries(coverage)) {
  if (!FILES[label]) continue;   // 「条级」不是规范文件，是条级对照本身
  const text = readFileSync(join(spec, FILES[label]), 'utf8');
  for (const clause of Object.keys(table)) {
    if (!text.includes(clause)) problems.push(`${label} · 对照表里的「${clause}」在规范里已经找不到了（表烂了，删掉它）`);
  }
}

console.log(`规范覆盖：四份规范共 ${total} 条（标题级）—— 有门禁 ${gated} · 明确靠人工 ${human}；另有**条级** ${tierChecked} 条（每条都指到门禁里真实的断言）`);
if (problems.length) {
  console.log('');
  for (const problem of problems) console.log('  ⚠ ' + problem);
  console.log(`\nFAIL: ${problems.length} 条规范没有明确的责任人（门禁或人工说明）。`);
} else {
  console.log('PASS: 每条规范都有明确的责任人 —— 要么有门禁在 verify 里跑，要么写清了人工看什么。');
}
process.exit(problems.length ? 1 : 0);
