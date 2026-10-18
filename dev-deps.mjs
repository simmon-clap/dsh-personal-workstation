/** 开发/门禁依赖的解析点（W4-3：仓库里不再出现作者的绝对路径）。
 *
 *  解析顺序：
 *    1. 仓库自己的 node_modules（干净机器 `npm install` 后走这里）；
 *    2. `DSH_DEV_NODE_MODULES` 指向的目录（把依赖装在别处时用）；
 *    3. `$DSH_HOME/profiles/desktop/node_modules`（本机 DSH profile 里已有的那份，作者机器零安装）。
 *  运行产品插件**不需要**这些依赖；它们只被测试与浏览器门禁使用。
 */
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

const here = import.meta.dirname ?? process.cwd();
const requireFrom = base => createRequire(base);
const candidates = [
  join(here, 'noop.js'),
  ...(process.env.DSH_DEV_NODE_MODULES ? [join(process.env.DSH_DEV_NODE_MODULES, 'noop.js')] : []),
  join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'desktop', 'node_modules', 'noop.js'),
];

function load(name) {
  const failures = [];
  for (const base of candidates) {
    try {
      return requireFrom(base)(name);
    } catch (error) {
      failures.push(base);
    }
  }
  throw new Error('缺少开发依赖 ' + name + '：请先 `npm install`（开发依赖），或设置 DSH_DEV_NODE_MODULES 指向已安装的 node_modules。尝试过：' + failures.join('、'));
}

const jsdom = load('jsdom');
export const JSDOM = jsdom.JSDOM;
export const puppeteer = load('puppeteer-core');

/** Chrome/Chromium 可执行文件：优先 CHROME_PATH，其次常见安装位置。 */
export function chromeExecutable() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const paths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
  return paths.find(candidate => existsSync(candidate)) ?? paths[0];
}
