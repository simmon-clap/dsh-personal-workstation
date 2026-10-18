#!/usr/bin/env node
/** 正在运行的工作台实例：**端口自动发现 + 凭据配对**（多实例 / 重启后端口变化都适用）。
 *
 *  为什么抽出来：`live-acceptance` / `live-visual-audit` / 新加的 `semantic-gates` 与
 *  `baseline-capture` 都需要同一件事实——「现在到底哪个端口、用哪条 cookie 能打开用户的真工作台」。
 *  各写一份就会各自漂移（2026-10-17 已有一个写死端口的脚本对空气发请求）。
 *
 *  只读：只做 `fetch` 探测，不点任何按钮、不写产品数据。
 *  凭据：本机 Chromium Cookies 库里 `127.0.0.1` 的会话（DSH 每次重启会发新 cookie，旧的可能 401）。
 *
 *  用法：import {findLiveTarget, launchBrowser, openPage} from './live-target.mjs';
 */
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {chromeExecutable} from '../dev-deps.mjs';

export const HOME = process.env.HOME ?? '';
export const COOKIES = join(HOME, 'Library/Application Support/@deepseek-ai/dsh-desktop/Cookies');
export const CHROME = chromeExecutable();

/** 本机会话 cookie，按最近使用时间倒序（重启后第一条可能已失效——由调用方逐条试）。 */
export function cookieStrings() {
  try {
    return execFileSync('/usr/bin/sqlite3', ['-separator', '|', COOKIES,
      "select name,value from cookies where host_key='127.0.0.1' order by last_access_utc desc;"], {encoding: 'utf8'})
      .trim().split('\n').filter(Boolean)
      .map(line => { const at = line.indexOf('|'); return line.slice(0, at) + '=' + line.slice(at + 1); });
  } catch { return []; }
}

/** 本机所有 127.0.0.1 监听端口（本机可能同时跑多个 DSH 实例）。 */
export function listeningPorts() {
  try {
    return [...new Set(execFileSync('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], {encoding: 'utf8'})
      .split('\n').filter(line => /127\.0\.0\.1:\d+/.test(line))
      .map(line => Number(/127\.0\.0\.1:(\d+)/.exec(line)[1]))
      .filter(Number.isFinite))];
  } catch { return []; }
}

/**
 * 找到「能用登录凭据打开工作台」的那个实例。
 * @returns {Promise<{base:string, cookie:string, pageUrl:string, candidates:string[]}>}
 */
export async function findLiveTarget({path = '/personal-workstation', timeoutMs = 1200} = {}) {
  // 一次性 token URL（`dsh web` 启动时会打印）→ 换一个会话 cookie，供门禁驱动真实实例。
  // 桌面窗口的 token 只在主进程内存里，外部拿不到；验收时另起一个 web 宿主并用这条路径。
  if (process.env.WORKSTATION_TOKEN_URL) {
    const tokenUrl = process.env.WORKSTATION_TOKEN_URL;
    const origin = new URL(tokenUrl).origin;
    const response = await fetch(tokenUrl, {redirect: 'manual'});
    const setCookie = response.headers.get('set-cookie') ?? '';
    const pair = setCookie.split(';')[0].trim();
    if (!pair.includes('=')) throw new Error('token URL 没有换到会话 cookie（HTTP ' + response.status + '）');
    return {base: origin, cookie: pair, pageUrl: origin + path, candidates: [origin]};
  }
  const candidates = process.env.WORKSTATION_ORIGIN
    ? [process.env.WORKSTATION_ORIGIN.replace(/\/+$/, '')]
    : listeningPorts().map(port => 'http://127.0.0.1:' + port);
  const cookies = cookieStrings();
  if (!cookies.length) throw new Error('没有找到本机会话 cookie（' + COOKIES + '）；先确认 DSH 桌面端已登录');
  for (const base of candidates) {
    for (const cookie of cookies) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const response = await fetch(base + path, {headers: {cookie}, signal: controller.signal}).finally(() => clearTimeout(timer));
        if (response.ok) return {base, cookie, pageUrl: base + path, candidates};
      } catch {}
    }
  }
  throw new Error('找不到能打开工作台(200)的实例与凭据组合；候选端口：' + candidates.join(', '));
}

/** profile 里装的那份依赖（puppeteer-core 在 profile 的 node_modules 里）。 */
export function profileRequire() {
  return createRequire(join(HOME, '.dsh/profiles/desktop/node_modules/'));
}

export async function launchBrowser() {
  const puppeteer = profileRequire()('puppeteer-core');
  return puppeteer.launch({executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']});
}

/** 打开工作台页面并等它真的渲染出来（空页面上量出来的结论不算数）。 */
export async function openPage(browser, target, {width = 1440, height = 940, mobile = false, settle = 1600} = {}) {
  const page = await browser.newPage();
  await page.setViewport({width, height, isMobile: mobile, hasTouch: mobile});
  const [name, ...rest] = target.cookie.split('=');
  await browser.setCookie({name, value: rest.join('='), domain: '127.0.0.1', path: '/'});
  await page.goto(target.pageUrl, {waitUntil: 'networkidle0'});
  await page.waitForFunction(() => document.querySelectorAll('.nav [data-view]').length >= 7, {timeout: 20000});
  await new Promise(resolve => setTimeout(resolve, settle));
  return page;
}

export const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 点一个一级导航并等页面稳定。 */
export async function gotoView(page, view, settle = 1100) {
  await page.evaluate(v => document.querySelector('.nav [data-view="' + v + '"]')?.click(), view);
  await wait(settle);
}
