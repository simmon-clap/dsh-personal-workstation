import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {checkTrackedData, dataShapeProblem} from '../prototype/private-data-guard.mjs';

// ── 发布工程门禁的回归保护（2026-10-19，01/03 审计的"假绿"清单） ─────────────
// 这些门禁依赖真实实例/浏览器/仓库外基线，不能在每个单测里整跑；
// 这里守住"判定逻辑本身不许退回假绿"，并用纯函数覆盖能拆出来的判据。

test('业务数据守卫：tracked 数据文件真的会判红（check③ 不再空转）',()=>{
 const findings=checkTrackedData(['src/store.mjs','README.md','data.sqlite','voice/a.m4a','会议/纪要.md','src/transcript.md']);
 assert.equal(findings.length,4,'数据库/录音/业务目录/转写稿必须各判红一次，普通源码与文档放行');
 assert(findings.some(item=>item.includes('data.sqlite')),'数据库文件必须命中');
 assert(findings.some(item=>item.includes('voice/a.m4a')),'录音必须命中');
 assert(findings.some(item=>item.includes('会议/纪要.md')),'业务数据目录必须命中');
 assert(findings.some(item=>item.includes('src/transcript.md')),'转写稿必须命中');
 assert.equal(checkTrackedData(['src/store.mjs','src/v7/app.mjs','README.md']).length,0,'普通源码/文档不得误报');
 assert.equal(dataShapeProblem('src/sync.mjs'),null);
});

test('业务数据守卫：自检命令能证明注入违规会红',()=>{
 const out=execFileSync(process.execPath,['prototype/private-data-guard.mjs','--self-test'],{encoding:'utf8'});
 assert.match(out,/PASS: 自检通过/);
});

test('公开仓库卫生检查：自检覆盖 .sh / 家目录 / 内网 IP / 凭证 / 私有词',()=>{
 const out=execFileSync(process.execPath,['prototype/public-repo-check.mjs','--self-test'],{encoding:'utf8'});
 assert.match(out,/PASS: 自检通过/);
 const source=readFileSync(new URL('../prototype/public-repo-check.mjs',import.meta.url),'utf8');
 assert.match(source,/ls-files/,'必须基于 git ls-files（真正会进仓库的文件）判定');
 assert.match(source,/PRIVATE_TERMS_FILE/,'必须支持从仓库外注入私有词表');
 assert.doesNotMatch(source,/'\.sh'\)\s*\)\s*continue/,'.sh 不得被扩展名过滤掉');
});

test('像素门禁：没有基线时必须判失败，不能只报数就退 0',()=>{
 const source=readFileSync(new URL('../prototype/pixel-diff.mjs',import.meta.url),'utf8');
 const block=/if\(!baseline\|\|!baseline\.pages\)\{([\s\S]*?)\n \}/.exec(source);
 assert.ok(block,'必须存在"没有基线"的分支');
 assert.match(block[1],/process\.exit\(1\)/,'没有基线必须非零退出（未判定 ≠ 通过）');
 assert.doesNotMatch(block[1],/process\.exit\(0\)/,'没有基线不得退 0');
 assert.match(source,/PIXEL_BASELINE/,'基线路径必须可注入，便于 CI 用夹具验证');
});

test('激活重放：没装包/没配置时不得静默 SKIP + exit 0',()=>{
 const source=readFileSync(new URL('../prototype/activation-replay.mjs',import.meta.url),'utf8');
 assert.match(source,/DEGRADED/,'缺环境时必须明确标记 DEGRADED');
 assert.doesNotMatch(source,/SKIP: 未找到已安装的包[^\n]*process\.exit\(0\)/,'缺包不得退 0');
 assert.doesNotMatch(source,/SKIP: 未找到 profile 配置[^\n]*process\.exit\(0\)/,'缺配置不得退 0');
 assert.match(source,/process\.exit\(2\)/,'缺环境必须非零退出');
});

test('真实实例验收：必须监听 pageerror / console.error，不许把"没有 JS 报错"写死成 true',()=>{
 const source=readFileSync(new URL('../prototype/live-acceptance.mjs',import.meta.url),'utf8');
 assert.match(source,/page\.on\('pageerror'/,'必须监听 pageerror');
 assert.match(source,/page\.on\('console'/,'必须监听 console.error');
 assert.doesNotMatch(source,/check\('整页没有 JavaScript 报错',\s*true\)/,'不得再硬编码 true');
 assert.match(source,/jsErrors\.length === 0/,'判据必须来自真实收集到的错误');
});
