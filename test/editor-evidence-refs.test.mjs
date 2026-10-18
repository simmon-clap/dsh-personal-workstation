/** 编辑判断**不许弄丢依据的出处**（2026-10-16 发现的数据丢失）。
 *
 *  现场：编辑器把「依据」做成一个 textarea（每行一条原文），回填时只写原文、**不写出处**；
 *  保存时又把每一行都重写成 `{kind:'note', ref:'user-said-N'}`。
 *  于是：**只要编辑一次判断（哪怕只是改个标题），它的文件/录音出处就全没了。**
 *
 *  为什么这条要紧：宪章判据 3 要求"任何一条判断能追回录音或文件的那一段" ——
 *  出处丢了，判据 3 就从手里漏走，而且**用户不会收到任何提示**。
 *
 *  判据（对着源码，因为这是表单解析逻辑）：
 *  ① 保存时必须拿已有依据做"原文 → 原样保留"的匹配；
 *  ② 匹配上的沿用原来的 kind/ref/verified，只有新写或改动的行才按"你的口述"处理；
 *  ③ 仍然不许冒充：新行不能凭空写成 file/audio 引用。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join, dirname} from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'prototype', 'editor.mjs'), 'utf8');
const block = (() => {
  const at = source.indexOf("if(name==='evidence'&&kind==='judgment')");
  assert.ok(at > 0, '找不到依据解析分支');
  return source.slice(at, source.indexOf('continue;', at));
})();

test('保存依据时要用已有依据做匹配（不能每行都重写）', () => {
  assert.match(block, /originals/, '必须拿到已有的依据列表');
  assert.match(block, /String\(row\.quote\?\?''\)\.trim\(\)===quote/, '按原文匹配');
  assert.match(block, /\.\.\.same/, '匹配上的要沿用原来那条（保留 kind/ref/verified）');
});

test('新写或改过的行仍按"你的口述"处理（不冒充文件/会话出处）', () => {
  assert.match(block, /kind:'note',ref:'user-said-/, '新行只能是你自己的口述');
  assert.doesNotMatch(block, /kind:'(file|audio|web|message)'/, '表单不许凭空造文件/录音出处');
});

test('匹配是按顺序、不重复使用同一条（避免两条原文相同就串了）', () => {
  assert.match(block, /used\.has\(at\)|used\.add\(/, '要记录已用过的原有条目');
});
