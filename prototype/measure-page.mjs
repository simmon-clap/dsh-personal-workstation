/** 页面度量：在真实浏览器里量圆角 / 间距 / 对比度 / 语义色 / 文字被挤成竖条。
 *
 *  抽成独立模块，是因为它要同时被两个地方用：
 *    · prototype/craft-audit.mjs   —— 对本地夹具（内存库 + 演示数据）跑，进 npm run verify
 *    · prototype/live-entry-check.mjs —— 对**真实运行中的工作台**跑（只读），用于真入口复验
 *  两边用同一套判据，才不会出现"夹具绿、真机红"。
 */
export const SCALE = [4, 8, 12, 16, 24, 32, 48, 64, 96];
export const RADIUS = [0, 8, 12, 20, 999];

/** 在页面里跑：量一个容器范围内的圆角/间距/对比度/语义色。这个函数会被序列化送进浏览器。 */
export function measureInPage(RADIUS, SCALE, rootSelector, CONTRACT = []) {
  const out = {radius: [], spacing: [], texts: [], purple: []};
  const root = rootSelector === 'body' ? document.body : document.querySelector(rootSelector);
  if (!root) return out;
  const describe = el => (el.className && typeof el.className === 'string' && el.className.trim())
    ? '.' + el.className.trim().split(/\s+/).join('.')
    : el.tagName.toLowerCase();
  const scope = [...(rootSelector === 'body' ? document.querySelectorAll('body *') : root.querySelectorAll('*'))];
  const seen = new Set();
  // 表单控件的 margin 默认来自**浏览器**（Chrome 给 checkbox 的是 3px/4px 那一套），不是我们的设计。
  // 为免把 UA 默认当成"标尺外间距"，先量一遍这些控件的 UA 默认 margin，命中就跳过（是谁写的要分清楚）。
  // auto 边距在计算样式里会被解析成像素（比如 44px / 204px / 278px）—— 光看计算值分不出"我写了 44px"
  // 还是"这里是个 auto"。所以先把**声明过 auto 边距的选择器**收集起来，命中的元素跳过 margin 判定。
  const autoSelectors = (() => {
    const selectors = [];
    const walk = list => {
      for (const rule of list) {
        if (rule.cssRules && rule.conditionText !== undefined) {
          try { if (!matchMedia(rule.conditionText).matches) continue } catch { continue }
          walk(rule.cssRules); continue;
        }
        if (rule.selectorText && /margin[^:]*:\s*[^;]*auto/.test(rule.style?.cssText ?? '')) selectors.push(rule.selectorText);
      }
    };
    for (const sheet of document.styleSheets) { try { walk(sheet.cssRules) } catch {} }
    return selectors;
  })();
  const usesAutoMargin = el => autoSelectors.some(selector => { try { return el.matches(selector) } catch { return false } });
  const uaMargin = (() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:-9999px';
    const values = new Set();
    // 注意：checkbox / radio 的 UA 默认 margin 与文本框**不同**（Chrome 给的是 3px/4px 那一套），
    // 第一版只探了默认 `input`（type=text），于是把 checkbox 的 UA 默认当成了"标尺外间距"报了假违规。
    for (const spec of ['input', 'select', 'textarea', 'button', 'input[type=checkbox]', 'input[type=radio]', 'label']) {
      const el = document.createElement('div');
      el.innerHTML = '<' + spec + '>';
      const child = el.firstElementChild;
      probe.append(child);
      values.add(getComputedStyle(child).margin);
      el.remove();
    }
    document.body.append(probe);
    const text = getComputedStyle(probe).margin;
    probe.remove();
    values.add(text);
    return values;
  })();
  for (const el of scope) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    const cls = describe(el);
    const key = cls + '|' + cs.borderRadius + '|' + cs.padding + '|' + cs.gap;
    if (seen.has(key)) continue;
    seen.add(key);
    const sample = (el.textContent || '').trim().slice(0, 16);
    const parent = el.parentElement ? describe(el.parentElement) : '';
    const corner = cs.borderTopLeftRadius;
    // 百分数半径是"圆点/圆形"（.dot / .statusdot 这类状态点），不是标尺上的像素值，不参与标尺判定。
    if (!/%/.test(corner)) {
      const radius = Number.parseFloat(corner);
      if (corner !== cs.borderTopRightRadius) {
        out.radius.push({cls, radius: cs.borderRadius, sample, parent});
      // **不带 ±1 容差**（2026-10-16 修）：原来写的是 `<= 1`，于是 9px 因为"离 8px 只差 1"
      // 被放过去了 —— 而算出来的值就是整数 9px，那是另一个**声明值**，不是渲染误差。
      // 实测后果：全站唯一真正渲染出来的违规圆角（画布工具条的 input，9px×4 个元素）从来没被抓到，
      // 门禁一直绿。规范只允许 8/12/20/999，就按相等判。
      } else if (Number.isFinite(radius) && !RADIUS.some(allowed => Math.abs(radius - allowed) < 1e-6)) {
        out.radius.push({cls, radius: cs.borderRadius, sample, parent});
      }
    }
    // **margin 也要查**（2026-10-16 补）：原来只查 padding 与 gap，而审计关心的 22px 恰恰写在 margin 上
    // （`.sectionhead` / `.footer` / `.drawer h2` / 任务区）—— 于是"间距标尺"这道门禁**永远管不到它**。
    // 两类豁免写在这里，不靠"登记即合法"：
    //   · `auto`（等于把元素推到边上，不是一个间距值）；
    //   · **负 margin**（视觉对齐的手法，比如让分区贴边、让标题光学对齐；VI 标尺管的是"留白"，
    //     负值不是留白。但它同样不该拿来做间距，所以只豁免负值本身，绝对值仍不参与标尺判定）。
    for (const [prop, value] of [['padding', cs.padding], ['gap', cs.gap], ['margin', cs.margin]]) {
      if (prop === 'gap' && value === 'normal') continue;
      if (prop === 'margin' && /auto/.test(String(value))) continue;
      if (prop === 'margin' && uaMargin.has(String(value))) continue;   // 整串都等于 UA 默认
      // **逐边**分辨（2026-10-16）：checkbox 的 UA 默认是 `3px 3px 3px 4px`，
      // 我们只改了 margin-top，于是整串变成 `4px 3px 3px 4px` —— 一比对"整串"就漏了，
      // 结果把浏览器给的 3px 当成"标尺外间距"报了出来（假违规）。
      // 所以对表单控件：某一边的值等于该控件类型的 UA 默认 → 这一边不算我们写的。
      const FORM = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON']);
      const uaSides = FORM.has(el.tagName)
        ? (() => { const probe = document.createElement(el.tagName === 'INPUT' ? 'input' : el.tagName.toLowerCase());
                   if (el.type) probe.type = el.type; probe.style.cssText = 'position:absolute;left:-9999px';
                   document.body.append(probe); const cs2 = getComputedStyle(probe);
                   const sides = [cs2.marginTop, cs2.marginRight, cs2.marginBottom, cs2.marginLeft];
                   probe.remove(); return sides })()
        : null;
      if (prop === 'margin' && usesAutoMargin(el)) continue;            // 声明了 auto：算出来的像素不是间距
      const parts = String(value).split(' ').map(v => Number.parseFloat(v)).filter(v => Number.isFinite(v));
      const offenders = parts.filter((v, index) => {
        if (v === 0 || v <= 0) return false;
        if (SCALE.some(allowed => Math.abs(v - allowed) <= 0.6)) return false;
        if (CONTRACT.some(allowed => Math.abs(v - allowed) < 1e-6)) return false;   // 已登记的信息架构度量（如侧栏宽 204）
        if (uaSides && uaSides[index] && Math.abs(v - Number.parseFloat(uaSides[index])) < 1e-6) return false;  // 浏览器给的那一边
        return true;
      });
      if (offenders.length) {
        out.spacing.push({cls, prop, value, sample});
      }
    }
    const purple = /117,\s*85,\s*161|199,\s*180,\s*235/.test(cs.color) || /117,\s*85,\s*161|243,\s*239,\s*248/.test(cs.backgroundColor);
    const dataDriven = /--p[cb]/.test(el.getAttribute('style') || '');
    if (purple && !dataDriven && !/knowledge|memory|judgment|topic|ai-|proposal|proof|memo|brief/i.test(cls) && sample) {
      out.purple.push({cls, text: sample});
    }
  }
  const lum = rgb => {
    const [r, g, b] = rgb.map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (const el of scope) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    if (el.children.length) continue;
    const text = (el.textContent || '').trim();
    if (!text) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    let node = el, bg = null;
    while (node && node !== document.documentElement) {
      const match = getComputedStyle(node).backgroundColor.match(/rgba?\(([^)]+)\)/);
      if (match) {
        const parts = match[1].split(',').map(Number);
        const alpha = parts.length > 3 ? parts[3] : 1;
        if (alpha > 0.5) { bg = parts.slice(0, 3); break; }
      }
      node = node.parentElement;
    }
    if (!bg) bg = [248, 249, 247];
    const fgMatch = cs.color.match(/rgba?\(([^)]+)\)/);
    if (!fgMatch) continue;
    const fg = fgMatch[1].split(',').map(Number).slice(0, 3);
    const size = Number.parseFloat(cs.fontSize), weight = Number.parseInt(cs.fontWeight, 10) || 400;
    const need = (size >= 18.66 || (size >= 14 && weight >= 700)) ? 3 : 4.5;
    const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    const got = (hi + 0.05) / (lo + 0.05);
    if (got < need - 0.01) {
      out.texts.push({cls: describe(el), text: text.slice(0, 20), got: Math.round(got * 100) / 100, need, size, color: cs.color, bg: 'rgb(' + bg.join(',') + ')'});
    }
  }
  // 排版事故：文字被挤成"一字一行"（内容盒很窄、行数却很多）。这类问题既不是圆角也不是间距，
  // 前面的门禁全看不出来 —— 第 2 轮我把新建菜单的紧凑排版误写到全站共用的 .resource 上，
  // 知识页的判断卡标题就变成了一列单字，而所有门禁依旧全绿。这里补上。
  for (const el of scope) {
    if (el.children.length) continue;
    const text = (el.textContent || '').trim();
    if (text.length < 8) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const lineHeight = Number.parseFloat(cs.lineHeight) || Number.parseFloat(cs.fontSize) * 1.5;
    const lines = Math.round(rect.height / lineHeight);
    if (lines >= 4 && rect.width < 90) {
      out.texts.push({cls: describe(el), text: text.slice(0, 16), got: 0, need: 0, size: Number.parseFloat(cs.fontSize), color: '被挤成竖条', bg: Math.round(rect.width) + 'px 宽 / ' + lines + ' 行'});
    }
  }
  return out;
}

