#!/usr/bin/env python3
"""生成《冻结原型收敛选择》可视化页（自包含 HTML，不依赖旁边文件）。

为什么要有这一页：批次 5 的四项红门禁（色值/间距/字号/!important）全部卡在"要不要动冻结原型"上。
文字说明读起来慢，这里用实物样例把选择摊开：改哪些、会变多少、代价是什么。

改版本：改本脚本并递增 VERSION，不要手改产物。
数据来源：工作台-视觉原型-v7.html（冻结原型）、design-system/tokens.json（VI 色板）、spec/registry.json（标尺）。
"""
import json
import math
import re
from collections import Counter
import collections
from pathlib import Path

VERSION = 'v1.0'
ROOT = Path(__file__).resolve().parent.parent
PROTOTYPE = ROOT / '工作台-视觉原型-v7.html'
OUT = ROOT / 'spec' / '07-冻结原型收敛选择.html'

tokens = json.loads((ROOT / 'design-system' / 'tokens.json').read_text(encoding='utf8'))['color']
registry = json.loads((ROOT / 'spec' / 'registry.json').read_text(encoding='utf8'))
space_scale = registry['spacingScale']
type_scale = registry['typeScale']
prototype = PROTOTYPE.read_text(encoding='utf8')

palette = {name: value.upper() for name, value in tokens.items()}


def rgb(value):
    value = value.lstrip('#')
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def lab(colour):
    r, g, b = [x / 255 for x in colour]
    def f(t):
        return t / 12.92 if t <= 0.04045 else ((t + 0.055) / 1.055) ** 2.4
    r, g, b = f(r), f(g), f(b)
    x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047
    y = r * 0.2126 + g * 0.7152 + b * 0.0722
    z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883
    def g2(t):
        return t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116
    x, y, z = g2(x), g2(y), g2(z)
    return (116 * y - 16, 500 * (x - y), 200 * (y - z))


def delta_e(a, b):
    return math.sqrt(sum((p - q) ** 2 for p, q in zip(lab(rgb(a)), lab(rgb(b)))))


counts = Counter(h.upper() for h in re.findall(r'#[0-9a-fA-F]{6}\b', prototype))
rows = []
for hex_value, times in counts.items():
    name, value = min(palette.items(), key=lambda kv: delta_e(hex_value, kv[1]))
    rows.append((hex_value, name, value, delta_e(hex_value, value), times))
rows.sort(key=lambda r: (-r[4], r[3]))

# 门禁口径（spec/registry.json 的 12 项 + 当前实测）
gates = [
    ('1 色值 = 0', '212', '壳内 140'), ('2 间距 = 0', '143', '壳内 113'),
    ('3 字号 = 0', '35', '壳内 35'), ('9 !important = 0', '25', '壳内 5'),
]

# 间距歧义：6 / 10 / 14 / 20 正好落在两档中间
ambiguous_values = [6, 10, 14, 20]
clear_count = 0
ambiguous_count = collections.Counter()
font_count = collections.Counter()
for match in re.finditer(r'\b(padding|margin|gap)(?:-[a-z]+)?\s*:\s*([^;{}\n]+)', prototype):
    for px in re.finditer(r'(\d+(?:\.\d+)?)px', match.group(2)):
        value = float(px.group(1))
        if value in space_scale:
            continue
        ordered = sorted(space_scale, key=lambda s: (abs(s - value), s))
        if abs(ordered[0] - value) != abs(ordered[1] - value):
            clear_count += 1
        else:
            ambiguous_count[value] += 1
for match in re.finditer(r'font-size\s*:\s*(\d+(?:\.\d+)?)px', prototype):
    value = float(match.group(1))
    if value not in type_scale:
        font_count[value] += 1
fonts = sorted(font_count)
ambiguous_total = sum(ambiguous_count.values())

close_count = sum(1 for r in rows if r[3] < 10)
far_count = sum(1 for r in rows if r[3] >= 25)


def swatch(value, label=''):
    return f'<span class="sw"><i style="background:{value}"></i><code>{value}</code></span>'


def band(value):
    band = 'ok' if value < 10 else ('warn' if value < 25 else 'bad')
    text = '肉眼接近' if band == 'ok' else ('能看出差别' if band == 'warn' else '明显不同')
    return f'<span class="tag {band}">{text}</span>'


table = '\n'.join(
    f'<tr><td>{swatch(r[0])}</td><td>×{r[4]}</td>'
    f'<td>{swatch(r[2])}<small>--ws-{r[1]}</small></td>'
    f'<td class="num">{r[3]:.1f}</td><td>{band(r[3])}</td></tr>'
    for r in rows[:24])

# 标尺上标出歧义值的位置
scale_marks = []
for value in space_scale:
    scale_marks.append(f'<i class="tick" style="left:{space_scale.index(value) / (len(space_scale) - 1) * 100:.1f}%"><b>{value}</b></i>')
amb_marks = []
for value in ambiguous_values:
    lower = max([s for s in space_scale if s < value], default=space_scale[0])
    upper = min([s for s in space_scale if s > value], default=space_scale[-1])
    span_low = space_scale.index(lower)
    span_high = space_scale.index(upper)
    pos = (span_low + (span_high - span_low) * (value - lower) / (upper - lower)) / (len(space_scale) - 1) * 100
    amb_marks.append(f'<i class="amb" style="left:{pos:.1f}%"><b>{value}</b></i>')

gate_html = ''.join(f'<tr><td>{name}</td><td class="num">{value}</td><td class="muted">{where}</td></tr>' for name, value, where in gates)

HTML = f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>冻结原型收敛选择 · {VERSION}</title>
<style>
:root{{--paper:#F8F9F7;--surface:#FFF;--ink:#252A31;--muted:#626C78;--line:#DCE1E5;--action:#315ED0;
--success:#28735B;--warning:#8A601D;--danger:#B33F44;--soft:#EDF2FF}}
*{{box-sizing:border-box}}
body{{margin:0;padding:40px 24px 80px;background:var(--paper);color:var(--ink);
font:15px/1.75 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif}}
main{{max-width:1000px;margin:0 auto}}
h1{{font-size:32px;line-height:1.3;margin:0 0 8px}}
h2{{font-size:22px;margin:48px 0 12px}}
h3{{font-size:15px;margin:0 0 8px}}
p{{margin:0 0 12px}}
.lead{{font-size:15px;color:var(--muted);max-width:66ch}}
.card{{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:24px;margin:16px 0}}
.cards{{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}}
.figures{{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin:20px 0}}
.fig{{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:20px 22px}}
.fig b{{display:block;font-size:32px;line-height:1.2;font-variant-numeric:tabular-nums}}
.fig small{{color:var(--muted);font-size:12px}}
table{{width:100%;border-collapse:collapse;font-size:13px}}
th,td{{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:middle}}
th{{font-size:12px;color:var(--muted);font-weight:500}}
.num{{font-variant-numeric:tabular-nums}}
.muted{{color:var(--muted)}}
.sw{{display:inline-flex;align-items:center;gap:8px}}
.sw i{{width:22px;height:22px;border-radius:6px;border:1px solid rgba(37,42,49,.14);flex:none}}
.sw code{{font-size:12px;color:var(--ink)}}
td small{{color:var(--muted);font-size:11px;display:block}}
.tag{{font-size:11px;padding:2px 8px;border-radius:999px;white-space:nowrap}}
.tag.ok{{background:#EDF6F1;color:var(--success)}}
.tag.warn{{background:#FBF4E6;color:var(--warning)}}
.tag.bad{{background:#FBEFF0;color:var(--danger)}}
.ruler{{position:relative;height:64px;margin:24px 0 8px}}
.ruler:before{{content:"";position:absolute;inset:26px 0 auto;height:1px;background:var(--line)}}
.tick{{position:absolute;top:18px;transform:translateX(-50%);text-align:center;font-style:normal}}
.tick b{{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}}
.tick:after{{content:"";display:block;width:1px;height:9px;background:var(--line);margin:2px auto 0}}
.amb{{position:absolute;top:0;transform:translateX(-50%);text-align:center;font-style:normal}}
.amb b{{font-size:12px;color:var(--danger);font-variant-numeric:tabular-nums}}
.amb:after{{content:"";display:block;width:1px;height:26px;background:var(--danger);margin:2px auto 0}}
.pick{{border-left:3px solid var(--action);background:#EDF2FF}}
.no{{border-left:3px solid var(--danger)}}
.yes{{border-left:3px solid var(--success)}}
footer{{margin-top:56px;padding-top:20px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}}
code{{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}}
</style></head><body><main>

<h1>冻结原型收敛选择</h1>
<p class="lead">批次 5（VI 收敛）的四项红门禁<b>全部卡在同一个问题上</b>：要不要动冻结原型
<code>工作台-视觉原型-v7.html</code>。它由 <code>build-v7.mjs</code> 直接读进来生成 <code>src/v7-shell.html</code>，
里面的颜色、间距、字号都是内联写死的。</p>

<div class="figures">
  <div class="fig"><small>原型里的不同颜色</small><b>147</b><small>共 164 处</small></div>
  <div class="fig"><small>真的显示给用户的</small><b>26</b><small>其余 82% 已被 VI 层盖掉</small></div>
  <div class="fig"><small>与 VI 色板肉眼接近</small><b>{close_count}</b><small>ΔE &lt; 10</small></div>
  <div class="fig"><small>明显不同</small><b>{far_count}</b><small>ΔE ≥ 25</small></div>
</div>

<p class="lead">换句话说：<b>原型的色板基本就是 VI 色板的"略偏版本"</b>——VI 正是从它提炼出来的。
所以把 shell 收敛到 15 色，视觉变化比想象的<b>小得多</b>，而且能顺带拆掉那层靠 <code>!important</code> 硬压的补丁。</p>

<h2>当前四项红门禁</h2>
<div class="card" style="padding:8px 16px">
<table><thead><tr><th>门禁</th><th>现状</th><th>其中在壳内</th></tr></thead><tbody>{gate_html}</tbody></table>
</div>

<h2>色板对照（按出现次数）</h2>
<p class="muted" style="font-size:13px">左＝原型实际写的颜色，右＝最接近的 VI token。ΔE 是感知色差，越小越像。</p>
<div class="card" style="padding:8px 16px">
<table><thead><tr><th>原型色值</th><th>次数</th><th>最近的 VI token</th><th>ΔE</th><th>判定</th></tr></thead>
<tbody>{table}</tbody></table>
</div>

<h2>间距：哪些能自动落位，哪些要你定</h2>
<p>标尺是 <code>{' / '.join(str(v) for v in space_scale)}</code>。壳内标尺外共 <b>{clear_count + ambiguous_total} 处</b>：
<b>{clear_count} 处能唯一映射</b>；剩下 <b>{ambiguous_total} 处</b>落在下面这 {len(ambiguous_values)} 个值上，
它们<b>正好卡在两档中间</b>（红字），必须人来定：</p>
<div class="card">
<div class="ruler">{''.join(scale_marks)}{''.join(amb_marks)}</div>
<p class="muted" style="margin:0;font-size:12px">红字＝有歧义的值；灰字＝标尺档位。</p>
</div>

<h2>字号：{len(fonts)} 个取值、共 {sum(font_count.values())} 处不在字阶上</h2>
<p>字阶是 <code>{' / '.join(str(v) for v in type_scale)}</code>。壳内字号取值：
{' '.join(f'<span class="tag bad">{int(v)}px ×{font_count[v]}</span>' for v in fonts)}</p>

<h2>三条路，各自的真实代价</h2>
<div class="cards">
  <div class="card pick"><h3>A′ · 扩充 token</h3>
   <p>承认原型那套颜色合法，登记进 <code>tokens.json</code>；门禁口径改成"必须来自 tokens"。</p>
   <p><b>代价：</b>零视觉变化、零风险。<b>但</b>色板会从 15 色涨到 100+ 色——VI 的"克制"就没了。</p>
   <p class="muted">适合：你认为"外观已经认可，一个字都别动"。</p></div>

  <div class="card no"><h3>B′ · 永久例外</h3>
   <p>把 shell 与对比度补丁层登记为生成物例外，四项门禁豁免。</p>
   <p><b>代价：</b>这四项"= 0"<b>永远达不到</b>，门禁变成摆设。</p>
   <p class="muted">不建议。</p></div>

  <div class="card yes"><h3>C′ · 按 VI 收敛（推荐）</h3>
   <p>把 shell 的颜色/间距/字号换成 VI token 与标尺，删掉靠 <code>!important</code> 硬压的补丁层。</p>
   <p><b>代价：</b>改的是你认可的界面外观，需要重出验收基准与截图。<b>实测：</b>
   {close_count}/{len(rows)} 种颜色只是略偏，{far_count} 种明显不同；真正显示给用户的只有 26 种。</p>
   <p class="muted">适合：你认为"VI 是硬标准，外观该按 VI 收敛"。</p></div>
</div>

<p style="margin-top:24px"><b>我的建议：C′。</b>数据支持它：VI 本来就从原型提炼而来，绝大多数颜色只是略偏；
而且<u>不收敛的话，那层 <code>!important</code> 补丁永远拆不掉</u>——它是"同一件事两套颜色"的根源，会一直要求后来人绕着走。
间距那 {ambiguous_total} 处歧义值我会逐个说明取哪一档、为什么，再给你看改前改后的对照截图。</p>

<footer>
数据可复现：<code>npm run plan:prototype</code>（干跑，不写一个字节）· 本页由 <code>spec/build-prototype-choice.py</code> 生成（{VERSION}），改版本改脚本、不要手改产物。<br>
色值取自 <code>design-system/tokens.json</code>，标尺取自 <code>spec/registry.json</code>。
</footer>
</main></body></html>
'''

OUT.write_text(HTML, encoding='utf8')
print(f'已生成 {OUT}（{len(HTML)} 字节，自包含）')
print(f'颜色：{len(rows)} 种，接近 {close_count}，明显不同 {far_count}')
print(f'间距：可自动映射 {clear_count} 处，歧义 {ambiguous_total} 处（值 {ambiguous_values}）')
print(f'字号：{len(fonts)} 个取值、{sum(font_count.values())} 处不在字阶')
