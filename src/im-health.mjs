/** IM 助理（飞书）四层健康：**只读**、只报事实、读不到就写读不到。
 *
 *  为什么需要它（17 C8 / 26 §4 P0-5 / 46 §1.5）：飞书失联不是"一个 bug"，是四层叠加——
 *  插件没加载 / 平台拒绝（21001）/ 会话目录指错 / 工作台没有发送代码。以前设置页只显示
 *  「飞书 未配置」，把"没加载"掩盖成"没配置"，用户无法行动。这里把四层各自的事实取出来，
 *  由界面逐层给出「下一步」。
 *
 *  边界（C9）：`channels.json` 里的 `config` 含明文凭据 —— **整个对象不进入返回值**，
 *  只取白名单字段；返回值里不出现 appSecret/appId/token，也不出现 home 绝对路径（用 ~ 缩写）。
 *
 *  纯函数 + 注入参数，便于 hermetic 单测：readImHealth({bundles, plugins, channels, log, ...})。
 */

import {readFileSync} from 'node:fs';
import {join} from 'node:path';

export const IM_PLUGIN = '@michengai/dsh-im-connect';
/** channels.json 只允许暴露这些字段；config 整块丢弃。 */
const CHANNEL_FIELDS = ['id', 'platform', 'name', 'enabled', 'receiveEnabled', 'cwd', 'lastError', 'updatedAt'];

const abbreviate = (value, home) => {
  if (typeof value !== 'string' || !value) return null;
  if (home && value === home) return '~';
  if (home && value.startsWith(home + '/')) return '~' + value.slice(home.length);
  return value;
};
const iso = value => {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
const unknown = reason => ({state: 'unknown', reason});

/** BundleInfo[] 归一：宿主可能直接返回数组，也可能包一层 {entries}。 */
function bundleList(bundles) {
  if (Array.isArray(bundles)) return bundles;
  if (Array.isArray(bundles?.entries)) return bundles.entries;
  if (Array.isArray(bundles?.bundles)) return bundles.bundles;
  return null;
}
function pluginList(plugins) {
  if (Array.isArray(plugins)) return plugins;
  if (Array.isArray(plugins?.entries)) return plugins.entries;
  if (Array.isArray(plugins?.plugins)) return plugins.plugins;
  return null;
}

/** L0：插件加载/兼容/启用。读不到 → unknown（不得推断"未安装/未加载"）。 */
function pluginHealth({bundles, plugins}) {
  const list = bundleList(bundles);
  const live = pluginList(plugins);
  if (!list && !live) return unknown('宿主没提供插件清单与加载状态');
  const row = list?.find(item => item?.name === IM_PLUGIN);
  if (list && !row) return unknown('宿主清单里没有 IM 助理插件（不推断为未安装）');
  const incompatible = row?.error?.code === 'incompatible-version' ? row.error.incompatible?.[0] : null;
  const base = {
    name: IM_PLUGIN,
    version: row?.version ?? incompatible?.version ?? null,
    runtimeVersion: incompatible?.runtimeVersion ?? null,
    requirementsSummary: incompatible?.requirements
      ? Object.keys(incompatible.requirements).length + ' 个宿主包要求 ' + [...new Set(Object.values(incompatible.requirements))].join(' / ')
      : null
  };
  if (incompatible) return {state: 'incompatible', ...base};
  if (row && row.enabled !== true) return {state: 'disabled', ...base};
  if (!live) return unknown('宿主没提供插件加载状态');
  const entry = live.find(item => {
    const text = [item?.entryId, item?.moduleName, item?.name].filter(Boolean).join(' ');
    return text.includes('im-connect');
  });
  if (!entry) return {...base, state: 'not-loaded', reason: '宿主加载清单里没有它'};
  const phase = entry.fiberPhase ?? entry.state ?? null;
  if (phase === 'active') return {...base, state: 'loaded'};
  if (phase === 'failed') return {...base, state: 'failed', reason: typeof entry.error === 'string' ? entry.error : '加载失败'};
  if (phase === 'pending' || phase === 'loading') return {...base, state: 'loading'};
  return {...base, state: 'not-loaded', reason: '没有进入运行状态'};
}

/** L1：渠道最近一次记录。工作台不做实时探测，所以**永远不报"已连接"**。 */
function channelHealth({channels, log}) {
  if (channels === null || channels === undefined) return {state: 'unknown', reason: '读不到本机渠道记录'};
  if (channels?.error) return unknown(channels.error);
  if (channels?.version !== 2) return unknown('渠道记录格式不认识（version≠2）');
  const all = Object.values(channels.channels ?? {});
  const feishu = all.filter(item => item?.platform === 'feishu');
  if (!feishu.length) return {state: 'no-account'};
  const account = feishu[0];
  const whitelisted = {};
  for (const key of CHANNEL_FIELDS) if (account[key] !== undefined) whitelisted[key] = account[key];
  const base = {
    id: whitelisted.id ?? null,
    title: whitelisted.name ?? null,
    enabled: whitelisted.enabled === true,
    receiveEnabled: whitelisted.receiveEnabled === true,
    lastError: typeof whitelisted.lastError === 'string' ? whitelisted.lastError : null,
    recordAt: iso(whitelisted.updatedAt),
    accountCount: feishu.length
  };
  if (whitelisted.enabled !== true) return {state: 'disabled', ...base};
  const failure = lastFailure(log);
  if (base.lastError) return {state: 'last-failure', ...base, log: failure};
  return {state: 'no-failure-recorded', ...base, log: failure};
}

/** 从 gateway.log 尾部找最后一次失败（只返回时间/code/一句人话，不带原文堆栈）。 */
export function lastFailure(logText) {
  if (typeof logText !== 'string' || !logText) return null;
  // 优先取**带错误码**的最近一行：日志尾部常常还有 router 的"挂载会话失败"（无 code），
  // 那不是飞书的拒绝，不该拿来当"渠道最近一次失败"的主因。
  const coded = [...logText.matchAll(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)[^\n]*\bcode:\s*(\d{4,6})\b/g)];
  if (coded.length) {
    const last = coded[coded.length - 1];
    const code = last[2];
    return {
      at: iso(last[1]),
      code,
      summary: code === '21001' ? '飞书拒绝签发 token（21001 访问控制）' : '飞书返回错误码 ' + code
    };
  }
  // 没有错误码时退回"最近一条失败行"（只说事实，不编原因）。
  const lines = logText.trim().split('\n').slice(-2000).reverse();
  for (const line of lines) {
    if (!/失败|failed|error/i.test(line)) continue;
    const at = /(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(line)?.[1] ?? null;
    return {at: iso(at), code: null, summary: '最近一次连接失败（日志没有错误码）'};
  }
  return null;
}

function cwdHealth({cwd, workspacePath, workspaceTitle, home, channelState}) {
  const value = abbreviate(typeof cwd === 'string' ? cwd : null, home);
  if (channelState === 'unknown' || !value) return unknown('读不到会话目录');
  const expected = workspacePath ?? null;
  const ok = expected ? cwd === expected : false;
  return {
    state: ok ? 'ok' : 'wrong',
    value,
    expectedTitle: workspaceTitle ?? null,
    expected: abbreviate(expected, home)
  };
}

/**
 * 读四层健康。
 * @param {{bundles?:any, plugins?:any, channels?:any, log?:string,
 *          home?:string, workspacePath?:string|null, workspaceTitle?:string|null, now?:()=>Date}} input
 *   bundles/plugins/channels/log 传 `null` 表示"没读到"；传对象/字符串表示已读取的原始数据。
 */
export function readImHealth({
  bundles = null, plugins = null, channels = null, log = null,
  home = process.env.HOME ?? '', workspacePath = null, workspaceTitle = null,
  now = () => new Date()
} = {}) {
  const plugin = pluginHealth({bundles, plugins});
  const channel = channelHealth({channels, log});
  const cwd = cwdHealth({cwd: channels?.channels ? Object.values(channels.channels).find(item => item?.platform === 'feishu')?.cwd : null, workspacePath, workspaceTitle, home, channelState: channel.state});
  return {
    readAt: now().toISOString(),
    sources: {
      bundles: bundleList(bundles) ? 'pluginManager.listBundles' : 'unavailable',
      plugins: pluginList(plugins) ? 'pluginManager.listPlugins' : 'unavailable',
      channels: channels?.error ? 'unreadable' : channels ? '~/.dsh/dsh-im-connect/channels.json' : 'unreadable',
      log: typeof log === 'string' ? '~/.dsh/dsh-im-connect/gateway.log' : 'unreadable'
    },
    plugin,
    channel,
    cwd,
    send: {implemented: false, note: '工作台没有往飞书发消息的代码；二级提醒降级为排在前面。'}
  };
}

/** 从本机读文件后再判定（宿主侧用这一层；任何异常都吞掉并返回 unknown，绝不抛）。 */
export function readImHealthFromDisk({
  bundles = null, plugins = null,
  dshDir = join(process.env.HOME ?? '', '.dsh'), home = process.env.HOME ?? '',
  workspacePath = null, workspaceTitle = null, now
} = {}) {
  const channelsPath = join(dshDir, 'dsh-im-connect', 'channels.json');
  const logPath = join(dshDir, 'dsh-im-connect', 'gateway.log');
  let channels = null, log = null;
  try { channels = JSON.parse(readFileSync(channelsPath, 'utf8')); } catch (error) { channels = {error: error?.code === 'ENOENT' ? '本机没有 IM 渠道记录' : '读不到本机渠道记录（' + (error?.code ?? '未知原因') + '）'}; }
  try { log = readFileSync(logPath, 'utf8').slice(-128 * 1024); } catch { log = null; }
  return readImHealth({bundles, plugins, channels, log, home, workspacePath, workspaceTitle, now});
}
