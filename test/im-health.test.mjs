/** IM 助理·飞书四层健康（W1 P0-5）的判据测试：T5-1…T5-7。
 *
 *  为什么单独一层：飞书失联是四层叠加（插件没加载 / 平台 21001 / 会话目录错 / 没有发送代码），
 *  以前设置页只写「飞书 未配置」，把"没加载"掩盖成"没配置"。这个模块只报事实、读不到写读不到；
 *  测试锁住"不许推断、不许泄漏凭据、不许把 home 绝对路径端给用户"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readImHealth, lastFailure, IM_PLUGIN} from '../src/im-health.mjs';

const HOME = '/Users/example';
const bundles = {
  entries: [
    {name: 'dsh-knowledge', enabled: true, installed: true, rows: []},
    {name: IM_PLUGIN, enabled: true, installed: true, availability: 'profile', version: '0.1.68', rows: [],
      error: {code: 'incompatible-version', incompatible: [{name: IM_PLUGIN, version: '0.1.68', runtimeVersion: '0.2.1-rc.2',
        requirements: {'@deepseek-ai/dsh-agent': '<=0.2.0-rc.2', '@deepseek-ai/dsh-client-locale': '<=0.2.0-rc.2'}}]}}
  ]
};
const plugins = {entries: [{entryId: 'include:dsh-knowledge', moduleName: 'dsh-knowledge', enabled: true, fiberPhase: 'active'}]};
const channels = {version: 2, channels: {
  feishu_x: {id: 'feishu_x', platform: 'feishu', name: '飞书账号', enabled: true, receiveEnabled: true,
    cwd: '/Users/example/.dsh/profiles/desktop', lastError: '连接失败，请查看本机日志',
    config: {appId: 'cli_secret_app', appSecret: 'SECRET-DO-NOT-LEAK', ownerOpenId: 'ou_xxx'}}
}};
const log = '2026-10-16T23:59:29.660Z [manager] 启动 feishu_x 失败: failed to get tenant_access_token, code: 21001, msg: Access denied by access control policy.';

test('T5-1：四层各自给出真实状态（插件不兼容 / 渠道上次失败 / cwd 错 / 发送未实现）', () => {
  const health = readImHealth({bundles, plugins, channels, log, home: HOME, workspacePath: '/Users/example/Desktop/DSH/飞书工作区', workspaceTitle: '飞书工作区'});
  assert.equal(health.plugin.state, 'incompatible');
  assert.equal(health.plugin.version, '0.1.68');
  assert.equal(health.plugin.runtimeVersion, '0.2.1-rc.2');
  assert.match(health.plugin.requirementsSummary, /宿主包要求/);
  assert.equal(health.channel.state, 'last-failure');
  assert.equal(health.channel.log.code, '21001');
  assert.match(health.channel.log.summary, /21001/);
  assert.equal(health.cwd.state, 'wrong');
  assert.match(health.cwd.value, /profiles\/desktop/, 'cwd 要如实给出当前值（缩写后）');
  assert.equal(health.cwd.expectedTitle, '飞书工作区');
  assert.equal(health.send.implemented, false);
});

test('T5-2：插件加载 → 渠道没有失败记录 → cwd 正确时四层都是 ok/off（不谎报已连接）', () => {
  const loaded = {entries: [{entryId: 'include:im-connect', moduleName: IM_PLUGIN, enabled: true, fiberPhase: 'active'}]};
  const cleanChannels = {version: 2, channels: {feishu_x: {id: 'feishu_x', platform: 'feishu', name: '飞书', enabled: true, receiveEnabled: true, cwd: '/Users/example/Desktop/DSH/飞书工作区'}}};
  const health = readImHealth({bundles: {entries: [{name: IM_PLUGIN, enabled: true, installed: true, version: '0.1.68', rows: []}]}, plugins: loaded, channels: cleanChannels, log: '', home: HOME, workspacePath: '/Users/example/Desktop/DSH/飞书工作区', workspaceTitle: '飞书工作区'});
  assert.equal(health.plugin.state, 'loaded');
  assert.equal(health.channel.state, 'no-failure-recorded', '没有失败记录 ≠ 已连接');
  assert.notEqual(health.channel.state, 'ok');
  assert.equal(health.cwd.state, 'ok');
});

test('T5-3：读不到就写读不到——不得推断「未安装 / 未加载 / 未配置」', () => {
  const health = readImHealth({bundles: null, plugins: null, channels: null, log: null, home: HOME});
  assert.equal(health.plugin.state, 'unknown');
  assert.equal(health.channel.state, 'unknown');
  assert.equal(health.cwd.state, 'unknown');
  assert.match(String(health.plugin.reason), /没提供|读不到/);
  assert.doesNotMatch(JSON.stringify(health.plugin), /未安装|未加载/);
});

test('T5-4：清单里没有这个插件 → unknown（不推断未安装）；phase failed → failed', () => {
  const missing = readImHealth({bundles: {entries: [{name: 'dsh-other', enabled: true}]}, plugins: {entries: []}, channels: null, home: HOME});
  assert.equal(missing.plugin.state, 'unknown');
  assert.match(String(missing.plugin.reason), /不推断/);
  const failed = readImHealth({bundles: {entries: [{name: IM_PLUGIN, enabled: true, version: '0.1.68'}]}, plugins: {entries: [{entryId: 'include:im-connect', moduleName: IM_PLUGIN, fiberPhase: 'failed'}]}, channels: null, home: HOME});
  assert.equal(failed.plugin.state, 'failed');
});

test('T5-5：凭据不泄漏、home 绝对路径不出现（T5-5）', () => {
  const health = readImHealth({bundles, plugins, channels, log, home: HOME, workspacePath: '/Users/example/Desktop/DSH/飞书工作区', workspaceTitle: '飞书工作区'});
  const json = JSON.stringify(health);
  for (const secret of ['SECRET-DO-NOT-LEAK', 'cli_secret_app', 'ou_xxx', 'appSecret', 'appId', 'ownerOpenId']) {
    assert(!json.includes(secret), '返回值不得包含凭据字段：' + secret);
  }
  assert(!json.includes('/Users/example'), '界面只需要 ~ 缩写，不把 home 绝对路径端给用户');
  assert.match(json, /~\//);
});

test('T5-6：渠道记录缺失/格式不认识/权限拒绝 → unknown + 原因，不抛（T5-6）', () => {
  const missing = readImHealth({bundles, plugins, channels: {error: '本机没有 IM 渠道记录'}, home: HOME});
  assert.equal(missing.channel.state, 'unknown');
  assert.match(missing.channel.reason, /没有 IM 渠道记录/);
  const badVersion = readImHealth({bundles, plugins, channels: {version: 1, channels: {}}, home: HOME});
  assert.equal(badVersion.channel.state, 'unknown');
  assert.match(badVersion.channel.reason, /version≠2|格式/);
  assert.doesNotThrow(() => readImHealth({bundles: null, plugins: null, channels: null, log: null, home: HOME}));
});

test('T5-7：没有飞书账号时说没有账号，而不是"未配置"（T5-7）', () => {
  const health = readImHealth({bundles, plugins, channels: {version: 2, channels: {slack_1: {id: 'slack_1', platform: 'slack', enabled: true}}}, home: HOME});
  assert.equal(health.channel.state, 'no-account');
});

test('lastFailure 只取最后一条失败，带 code 时给出人话；坏日志返回 null', () => {
  assert.equal(lastFailure(''), null);
  assert.equal(lastFailure('no timestamps here'), null);
  const failure = lastFailure(log + '\n2026-10-17T00:01:00.000Z [manager] ok');
  assert.equal(failure.code, '21001');
  assert.match(failure.summary, /访问控制|21001/);
});

test('返回值是无损 JSON：往返后深度相等（宿主会拒收 undefined/NaN/class 实例）', () => {
  const health = readImHealth({bundles, plugins, channels, log, home: HOME, workspacePath: '/x/飞书工作区', workspaceTitle: '飞书工作区'});
  const roundtrip = JSON.parse(JSON.stringify(health));
  assert.deepEqual(roundtrip, health, '含 undefined/NaN 的返回值会被宿主整次拒收（2026-10-17 铁律）');
  assert.equal(JSON.stringify(health).includes('undefined'), false);
});
