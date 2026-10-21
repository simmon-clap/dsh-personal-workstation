#!/usr/bin/env python3
"""生成《个人工作台 · VI 规范》可视化版本（自包含 HTML）。

用法：python3 spec/build-vi-spec.py
产物：spec/02-VI规范-v1.0.html

规则：
- 唯一色值/标尺来源是 design-system/tokens.json；
- 图标与简笔画从 design-system/assets 内联，成品不依赖任何外部文件；
- 后续修订直接改本脚本并递增 VERSION，不要手改产物。
"""
from pathlib import Path
import json, html

ROOT = Path(__file__).resolve().parent.parent
SPEC = ROOT / 'spec'
DS = ROOT / 'design-system'
VERSION = 'v1.0'
DATE = '2026-10-13'
OUT = SPEC / f'02-VI规范-{VERSION}.html'

tokens = json.loads((DS / 'tokens.json').read_text(encoding='utf8'))
colors = tokens['color']
spaces = tokens['space']
radii = tokens['radius']
motion = tokens['motion']
typography = tokens['font']['size']
mark = (DS / 'assets' / 'mark.svg').read_text(encoding='utf8')
mark_blue = (DS / 'assets' / 'mark-blue.svg').read_text(encoding='utf8')
mark_rev = (DS / 'assets' / 'mark-reverse.svg').read_text(encoding='utf8')
app_icon = (DS / 'assets' / 'app-icon.svg').read_text(encoding='utf8')
icons = {p.stem: p.read_text(encoding='utf8') for p in sorted((DS / 'assets' / 'icons').glob('*.svg'))}
arts = {p.stem: p.read_text(encoding='utf8') for p in sorted((DS / 'assets' / 'illustrations').glob('*.svg'))}

ICON_LABELS = {
    'overview': '总览', 'space': '关联空间', 'project': '项目', 'task': '任务', 'knowledge': '知识',
    'calendar': '日程', 'settings': '设置', 'assistant': '助理', 'file': '文件', 'link': '关联',
    'plus': '新增', 'close': '关闭', 'arrow': '前进', 'search': '搜索', 'inbox': '收件箱',
    'upload': '导入', 'download': '导出', 'edit': '编辑', 'check': '确认', 'warning': '警告',
    'pause': '暂停', 'play': '执行', 'clock': '时间', 'retry': '重试', 'device': '本机',
    'mini': '常驻节点', 'lock': '授权', 'focus': '聚焦', 'filter': '筛选', 'memory': '记忆',
    'cloud': '云端', 'chip': '芯片',
}
ART_LABELS = {
    'connections': '让工作相连', 'projects': '把目标向前推进', 'knowledge': '知识逐页积累',
    'focus': '给重要的事一点空间', 'empty': '准备开始', 'waiting': '等待必要的输入',
    'offline': '连接暂时中断', 'complete': '阶段完成，留有来路',
}
SWATCH_TEXT = {
    'paper': '#F8F9F7', 'surface': '#FFFFFF', 'ink': '#252A31', 'muted': '#626C78',
    'line': '#DCE1E5', 'action': '#315ED0', 'action-soft': '#EDF2FF',
    'success': '#28735B', 'success-soft': '#EDF6F1', 'warning': '#8A601D', 'warning-soft': '#FBF4E6',
    'danger': '#B33F44', 'danger-soft': '#FBEFF0', 'knowledge': '#7555A1', 'knowledge-soft': '#F3EFF8',
}
SWATCH_USE = {
    'paper': '页面底', 'surface': '内容容器', 'ink': '正文', 'muted': '次级／辅助', 'line': '分隔线',
    'action': '行动与聚焦（唯一主色）', 'action-soft': '操作区底',
    'success': '已完成', 'success-soft': '完成底', 'warning': '等待／不确定性', 'warning-soft': '限制底',
    'danger': '失败', 'danger-soft': '失败底', 'knowledge': 'AI 推导／记忆', 'knowledge-soft': '推导底',
}

# ---------------- 组件：四态样例 ----------------
def four_states(kind):
    if kind == 'primary':
        cells = [
            ('默认', 'class="b pri"'), ('悬停', 'class="b pri hover"'),
            ('聚焦', 'class="b pri focus"'), ('禁用', 'class="b pri dis"'),
        ]
    elif kind == 'secondary':
        cells = [
            ('默认', 'class="b sec"'), ('悬停', 'class="b sec hover"'),
            ('聚焦', 'class="b sec focus"'), ('禁用', 'class="b sec dis"'),
        ]
    else:
        cells = [
            ('默认', 'class="b txt"'), ('悬停', 'class="b txt hover"'),
            ('聚焦', 'class="b txt focus"'), ('禁用', 'class="b txt dis"'),
        ]
    return ''.join(f'<div class="state"><span {c}>按钮</span><small>{n}</small></div>' for n, c in cells)

TOC = [
    ('rel', '00', '与宪章的关系'), ('mark', '01', '标识'), ('color', '02', '色彩'), ('type', '03', '字体与排版'),
    ('space', '04', '间距 · 圆角 · 层'), ('icon', '05', '图标'), ('art', '06', '简笔画'),
    ('comp', '07', '组件唯一来源'), ('state', '08', '状态与反馈'), ('judge', '09', '判断与建议 V1–V3'),
    ('canvas', '10', '关系与画布'), ('share', '11', '分享形态 V7'), ('a11y', '12', '无障碍与多端'),
    ('host', '13', '宿主主题 V6'), ('clauses', '14', 'V1–V9 权威定义'), ('gate', '15', '门禁 12 项'),
    ('assets', '16', '交付资产与版本'),
]

css = """
:root{--paper:%(paper)s;--surface:%(surface)s;--ink:%(ink)s;--muted:%(muted)s;--line:%(line)s;
--action:%(action)s;--action-soft:%(action_soft)s;--success:%(success)s;--success-soft:%(success_soft)s;
--warning:%(warning)s;--warning-soft:%(warning_soft)s;--danger:%(danger)s;--danger-soft:%(danger_soft)s;
--knowledge:%(knowledge)s;--knowledge-soft:%(knowledge_soft)s;
--font:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
[data-theme=dark]{--paper:#191C20;--surface:#22262B;--ink:#EEF1F5;--muted:#A5AFBB;--line:#414955;
--action:#A9BCFF;--action-soft:#2C3751;--success:#9AD2BC;--success-soft:#243D34;
--warning:#E4C18B;--warning-soft:#413727;--danger:#F0AFB2;--danger-soft:#482E32;
--knowledge:#C7B4EB;--knowledge-soft:#393148}
*{box-sizing:border-box;letter-spacing:0}
body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.8 var(--font);-webkit-font-smoothing:antialiased}
b,strong{font-weight:600}
code{font:12px/1.6 ui-monospace,SFMono-Regular,monospace;background:var(--action-soft);color:var(--action);padding:2px 6px;border-radius:5px}
.num{font-variant-numeric:tabular-nums}
.top{position:fixed;top:0;left:0;right:0;height:62px;z-index:20;display:flex;align-items:center;justify-content:space-between;padding:0 26px;background:var(--paper);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:11px;font-size:15px;font-weight:600}
.brand svg{width:31px;height:31px}
.brand span{border-left:1px solid var(--line);padding-left:13px;font-size:11px;font-weight:400;color:var(--muted)}
.top-actions{display:flex;gap:8px;align-items:center}
.top-actions button{font:12px var(--font);min-height:34px;padding:6px 12px;border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:8px;cursor:pointer}
.toc{position:fixed;top:62px;left:0;bottom:0;width:214px;border-right:1px solid var(--line);padding:22px 14px;overflow:auto;display:flex;flex-direction:column;background:var(--paper)}
.toc>small{font:10px/1.5 ui-monospace,monospace;letter-spacing:.14em;color:var(--muted);padding:0 10px 14px}
.toc a{display:flex;gap:11px;align-items:baseline;font-size:12px;color:var(--muted);text-decoration:none;padding:8px 11px;border-radius:7px;line-height:1.5}
.toc a em{font:10px ui-monospace,monospace;font-style:normal;min-width:18px}
.toc a:hover{background:var(--action-soft);color:var(--ink)}
.toc a.on{background:var(--surface);color:var(--ink);font-weight:600}
.toc footer{margin-top:auto;padding:20px 10px 0;font-size:10px;line-height:1.9;color:var(--muted)}
main{margin:62px 0 0 214px;padding:0 50px;max-width:1160px}
section{padding:48px 0 54px;border-bottom:1px solid var(--line)}
.eyebrow{font:11px/1.5 ui-monospace,monospace;letter-spacing:.14em;color:var(--muted);margin-bottom:18px}
h1{font-size:33px;line-height:1.32;font-weight:550;margin:0 0 14px}
h2{font-size:23px;line-height:1.45;font-weight:600;margin:0 0 12px}
h3{font-size:15px;font-weight:600;margin:26px 0 8px}
p{margin:10px 0 0;color:var(--muted)}
.lead{font-size:15px;line-height:2;max-width:840px}
ul,ol{padding-left:19px;color:var(--muted);font-size:13.5px;line-height:2}
li b{color:var(--ink)}
table{width:100%%;border-collapse:collapse;margin-top:18px;font-size:13px}
th,td{text-align:left;padding:11px 13px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:11px;font-weight:600;color:var(--muted);letter-spacing:.04em;background:var(--paper)}
tr:last-child td{border-bottom:0}
.tblwrap{background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.tblwrap table{margin:0}
.key{background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--action);border-radius:0 12px 12px 0;padding:17px 21px;margin:18px 0 0;font-size:14.5px;line-height:1.85;color:var(--ink)}
.key small{display:block;font-size:12px;color:var(--muted);margin-top:8px;line-height:1.8}
.key.warn{border-left-color:var(--warning)}
.key.bad{border-left-color:var(--danger)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:20px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:20px}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:20px}
.panel h4{margin:0 0 8px;font-size:14px}
.panel p{font-size:12.5px;margin:0}
.demo{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:20px;margin-top:16px}
.demo .lbl{font:10px/1.5 ui-monospace,monospace;letter-spacing:.1em;color:var(--muted);margin-bottom:12px}
/* 色彩 */
.swatches{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-top:20px}
.sw{display:block;text-align:left;border:0;background:transparent;padding:0;cursor:pointer;font:inherit;color:inherit}
.sw i{display:block;height:78px;border:1px solid var(--line);border-radius:8px;margin-bottom:10px}
.sw b{display:block;font-size:11px}
.sw code,.sw small{display:block;color:var(--muted);font-size:10px;background:none;padding:0}
.sw:hover i{transform:translateY(-3px)}
/* 类型 */
.type-row{display:grid;grid-template-columns:118px 1fr 92px;gap:12px;align-items:center;padding:15px 0;border-bottom:1px solid var(--line)}
.type-row:last-child{border-bottom:0}
.type-row>span:first-child{font:10px ui-monospace,monospace;color:var(--muted)}
.type-row em{font-size:11px;font-style:normal;color:var(--muted);text-align:right}
/* 间距 */
.space-strip{display:flex;align-items:flex-end;gap:24px;padding:16px 0;overflow:auto}
.space-strip div{display:flex;flex-direction:column;align-items:center;gap:10px;min-width:16px}
.space-strip i{display:block;background:var(--action-soft);border:1px solid var(--action);border-radius:2px}
.space-strip code{font-size:11px;color:var(--muted);background:none;padding:0}
.radii{display:flex;gap:18px;flex-wrap:wrap;margin-top:14px}
.radii div{text-align:center}
.radii i{display:block;width:74px;height:56px;background:var(--surface);border:1px solid var(--line);margin-bottom:8px}
.radii small{font-size:11px;color:var(--muted)}
/* 图标 */
.icon-grid{display:grid;grid-template-columns:repeat(8,1fr);border-left:1px solid var(--line);border-top:1px solid var(--line);margin-top:18px}
.icon-grid div{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;height:104px;border-bottom:1px solid var(--line);border-right:1px solid var(--line);background:var(--surface)}
.icon-grid svg{width:24px;height:24px}
.icon-grid span{font-size:11px}
.icon-grid code{font-size:9px;color:var(--muted);background:none;padding:0;margin-top:-6px}
/* 简笔画 */
.art-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:18px}
.art-grid div{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px;text-align:center}
.art-grid svg{width:100%%;height:126px}
.art-grid b{display:block;font-size:12px;margin-top:6px}
.art-grid small{font-size:10px;color:var(--muted)}
/* 标识 */
.mark-row{display:flex;gap:14px;flex-wrap:wrap;margin-top:18px}
.mark-tile{flex:1 1 200px;min-height:158px;border-radius:12px;display:flex;align-items:center;justify-content:center;gap:16px;flex-direction:column}
.mark-tile svg{width:54px;height:54px}
.mark-tile span{font-size:11px}
.m-light{background:#fff;color:#252a31;border:1px solid #dce1e5}
.m-blue{background:#315ed0;color:#fff}
.m-dark{background:#252a31;color:#fff}
.mark-lockup{display:flex;align-items:center;gap:14px;padding:26px;background:var(--surface);border:1px solid var(--line);border-radius:12px}
.mark-lockup svg{width:64px;height:64px}
.mark-lockup b{font-size:22px}
.mark-lockup small{display:block;font-size:9px;letter-spacing:.15em;color:var(--muted);margin-top:5px}
/* 组件 */
.state-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.state{display:flex;flex-direction:column;align-items:center;gap:9px;padding:16px 8px;background:var(--surface);border:1px solid var(--line);border-radius:10px}
.state small{font-size:11px;color:var(--muted)}
.b{font:13px var(--font);min-height:36px;padding:8px 15px;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--ink);display:inline-flex;align-items:center}
.b.pri{background:var(--action);border-color:var(--action);color:#fff}
.b.sec{background:var(--surface);border-color:#b9c8ec;color:var(--action)}
.b.txt{border-color:transparent;background:transparent;color:var(--muted)}
.b.hover{background:var(--action-soft);border-color:var(--action)}
.b.pri.hover{background:var(--action);filter:brightness(.94)}
.b.focus{outline:3px solid var(--action);outline-offset:3px}
.b.dis{opacity:.45;cursor:not-allowed}
.field{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
.field label{font-size:12px;font-weight:500}
.field input,.field select{border:1px solid #909ba7;background:var(--surface);color:var(--ink);border-radius:8px;padding:9px 11px;font:13px var(--font);width:100%%}
.field .err{border-color:var(--danger)}
.field small{font-size:11px;color:var(--muted)}
.field small.bad{color:var(--danger)}
.dialog-demo{border:1px solid var(--line);border-radius:20px;overflow:hidden;background:var(--surface);max-width:520px;margin:0 auto;box-shadow:0 14px 40px rgba(32,37,44,.10)}
.dialog-demo header{background:var(--paper);padding:11px 18px;display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--muted);border-bottom:1px solid var(--line)}
.dialog-demo article{padding:20px 18px}
.dialog-demo article h5{margin:0;font-size:18px;font-weight:600}
.dialog-demo article p{font-size:12.5px}
.dialog-demo footer{background:var(--action-soft);padding:12px 18px;display:flex;justify-content:flex-end;gap:8px}
/* 状态语言 */
.states{display:grid;gap:10px;margin-top:18px}
.st{display:grid;grid-template-columns:150px 1fr;gap:16px;padding:13px 18px;background:var(--surface);border:1px solid var(--line);border-radius:10px;font-size:12.5px;align-items:baseline}
.st b{font-size:12.5px}
.tag{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-size:11.5px;white-space:nowrap}
.t-ok{background:var(--success-soft);color:var(--success)}
.t-warn{background:var(--warning-soft);color:var(--warning)}
.t-bad{background:var(--danger-soft);color:var(--danger)}
.t-ai{background:var(--knowledge-soft);color:var(--knowledge)}
.t-act{background:var(--action-soft);color:var(--action)}
.t-neu{background:var(--paper);color:var(--muted);border:1px solid var(--line)}
.dot{width:7px;height:7px;border-radius:50%%;display:inline-block}
/* 判断与建议 */
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:17px 19px}
.card.advice{border-left:3px solid var(--action);border-radius:0 12px 12px 0}
.card.rejected{border-left:3px solid var(--line)}
.card.judgment{border-left:3px solid var(--ink)}
.card .row1{display:flex;justify-content:space-between;gap:12px;align-items:baseline;font-size:11px;color:var(--muted)}
.card .row1 i{font-style:normal;color:var(--knowledge)}
.card h5{margin:9px 0 0;font-size:14.5px;font-weight:550;line-height:1.7}
.card.rejected h5{color:var(--muted)}
.card .hr{height:1px;background:var(--line);margin:13px 0 11px}
.card .ev{font-size:12.5px;color:var(--action)}
.card .unc{font-size:12.5px;color:var(--warning);margin-top:6px}
.card .when{font-size:11.5px;color:var(--muted);margin-top:6px}
.btns{display:flex;gap:8px;align-items:center;margin-top:14px;flex-wrap:wrap}
.quote{background:var(--paper);border-left:2px solid var(--line);padding:8px 12px;font-size:12px;color:var(--muted);margin-top:10px}
.trace{margin-top:12px;background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:13px 15px;font-size:12.5px}
.trace summary{cursor:pointer;color:var(--action);font-size:12.5px}
.trace ul{margin:10px 0 0;padding-left:0;list-style:none;font-size:12.5px}
.trace li{padding:7px 0;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:10px;color:var(--ink)}
.trace li small{color:var(--muted);font-size:11px;white-space:nowrap}
.layers{display:flex;align-items:flex-end;gap:26px;margin-top:16px;flex-wrap:wrap}
.layer{text-align:center}
.layer i{display:block;background:var(--surface);border:1px solid var(--line);border-radius:10px;width:150px;max-width:100%%}
.layer small{display:block;font-size:11px;color:var(--muted);margin-top:8px}
.foot{display:flex;justify-content:space-between;gap:16px;color:var(--muted);font-size:10px;letter-spacing:.06em;padding:22px 0 42px}
@media(max-width:1050px){.toc{display:none}main{margin-left:0;padding:0 22px}.grid2,.grid3{grid-template-columns:1fr}.swatches{grid-template-columns:repeat(3,1fr)}.icon-grid{grid-template-columns:repeat(4,1fr)}.art-grid{grid-template-columns:repeat(2,1fr)}.state-grid{grid-template-columns:repeat(2,1fr)}h1{font-size:26px}.layers{gap:12px}.layer i{width:96px}.layer small{font-size:10px}.space-strip{gap:16px}}
@media print{.top,.toc{display:none}main{margin:0;padding:0 16px;max-width:none}section{break-inside:avoid}}
""" % {
    'paper': colors['paper'], 'surface': colors['surface'], 'ink': colors['ink'], 'muted': colors['muted'],
    'line': colors['line'], 'action': colors['action'], 'action_soft': colors['action-soft'],
    'success': colors['success'], 'success_soft': colors['success-soft'],
    'warning': colors['warning'], 'warning_soft': colors['warning-soft'],
    'danger': colors['danger'], 'danger_soft': colors['danger-soft'],
    'knowledge': colors['knowledge'], 'knowledge_soft': colors['knowledge-soft'],
}

# ---------------- 各节内容 ----------------
def sec_swatches():
    out = []
    for key, label in [('paper', '纸白'), ('surface', '纯白'), ('ink', '墨色'), ('muted', '灰墨'), ('line', '雾线'),
                       ('action', '工作蓝'), ('action-soft', '浅蓝'), ('success', '完成绿'), ('success-soft', '完成底'),
                       ('warning', '赭色'), ('warning-soft', '限制底'), ('danger', '失败红'), ('danger-soft', '失败底'),
                       ('knowledge', '知识紫'), ('knowledge-soft', '推导底')]:
        value = colors[key]
        out.append(f'<button class="sw" data-copy="{value}"><i style="background:{value}"></i>'
                   f'<b>{label}</b><code>{value}</code><small>--ws-{key} · {SWATCH_USE[key]}</small></button>')
    return '<div class="swatches">' + ''.join(out) + '</div>'


TYPE_ROWS = [
    ('metric', '32 / 40 · 550', 32, 550, '15 / 31', '数据'),
    ('dialog', '22 / 30 · 600', 22, 600, '联合验证', '弹窗标题'),
    ('section', '18 / 26 · 600', 18, 600, '重点项目', '模块标题'),
    ('labelLarge', '15 / 24 · 600', 15, 600, '关联空间', '卡片标题'),
    ('body', '14 / 22 · 400', 14, 400, '明确目标，记录下一步行动。', '正文'),
    ('label', '13 / 20 · 600', 13, 600, '交付项', '标签'),
    ('caption', '12 / 18 · 400', 12, 400, '3 份资料 · 更新于 10:30', '辅助'),
    ('cramped', '11 / 16 · 400', 11, 400, '2026-10-11 14:20', '最小（时间/坐标）'),
]


def sec_type():
    rows = []
    for _, spec, size, weight, sample, use in TYPE_ROWS:
        content = f'<strong style="font-size:{size}px;font-weight:{weight}">{sample}</strong>' if size >= 18 \
            else f'<span style="font-size:{size}px;font-weight:{weight}">{sample}</span>'
        rows.append(f'<div class="type-row"><span>{size} / {spec.split("/")[1].strip().split("·")[0].strip()} · {weight}</span>'
                    f'{content}<em>{use}</em></div>')
    return '<div class="tblwrap" style="padding:4px 22px">' + ''.join(rows) + '</div>'


def sec_space():
    strip = ''.join(f'<div><i style="width:{n}px;height:{n}px"></i><code>{n}</code></div>' for n in spaces)
    labels = {'control': '控件', 'card': '内容容器', 'dialog': '居中弹窗', 'pill': '标签'}
    radii_demo = ''.join(
        f'<div><i style="border-radius:{value}px"></i>'
        f'<small>{labels.get(k, k)} · {value}px</small></div>'
        for k, value in radii.items())
    return ('<div class="demo"><div class="lbl">间距标尺（唯一，标尺外像素值不允许出现）</div>'
            f'<div class="space-strip">{strip}</div></div>'
            f'<h3>圆角</h3><div class="radii">{radii_demo}</div>')


def sec_icons():
    cells = ''.join(f'<div>{icons[k]}<span>{ICON_LABELS.get(k, k)}</span><code>{k}</code></div>' for k in icons)
    return f'<div class="icon-grid">{cells}</div>'


def sec_arts():
    cells = ''.join(f'<div>{arts[k]}<b>{ART_LABELS.get(k, k)}</b><small>{k}.svg</small></div>' for k in arts)
    return f'<div class="art-grid">{cells}</div>'


def sec_components():
    return f'''
<h3>按钮 · 三档 × 四态</h3>
<div class="demo"><div class="lbl">主（一视图仅一个）</div><div class="state-grid">{four_states("primary")}</div></div>
<div class="demo"><div class="lbl">次（白底描边）</div><div class="state-grid">{four_states("secondary")}</div></div>
<div class="demo"><div class="lbl">文字（低优先级）</div><div class="state-grid">{four_states("text")}</div></div>
<h3>字段 · 错误态就在字段旁</h3>
<div class="demo"><div class="grid2">
<div><div class="field"><label>项目名称 <span style="color:var(--danger)">*</span></label>
<input value="联合验证"><small>1–80 字</small></div></div>
<div><div class="field"><label>合作机构</label>
<input class="err" value="" aria-invalid="true"><small class="bad">请填写合作机构，或在下方选择「暂不指定」</small></div></div>
</div></div>
<h3>居中弹窗 · 唯一形态</h3>
<div class="demo"><div class="lbl">标题＝类型 · 记录名；动作区 ≤2 处；Escape 关闭；焦点锁定与恢复</div>
<div class="dialog-demo"><header><span>项目 · 联合验证</span><span>×</span></header>
<article><h5>6 / 8 项交付</h5><p>当前阶段：方案 · 剩余交付 2 项 · 资料 3 份</p>
<div class="quote">正文区：白／浅灰，只读信息与编辑区分离。</div></article>
<footer><span class="b sec">关闭</span><span class="b pri">编辑项目</span></footer></div></div>
'''


def sec_states():
    rows = [
        ('进行中', '<span class="tag t-neu">正在读取资料</span>', '静态骨架保留布局；超 1 秒才提示', '不显示假百分比；未知总量用不定进度'),
        ('已完成', '<span class="tag t-ok"><i class="dot" style="background:var(--success)"></i>已完成</span>', '有真实回执才可说"已保存"', '左下常驻「已保存 · 撤销」'),
        ('等待', '<span class="tag t-warn">等待输入：缺试点资料</span>', '写明等谁／等什么', '没写原因就"原因未记录"'),
        ('失败', '<span class="tag t-bad">保存未完成 · 版本已变化</span>', '一句人话 + 一个可点的下一步', '禁止 JSON、禁止技术堆栈'),
        ('未接入', '<span class="tag t-neu">任务执行器未接入</span>', '不给做不到的按钮', '说明需要什么才能用'),
        ('推断 · 待核对', '<span class="tag t-ai"><i>◇</i>AI 判断 · 待核对</span>', '紫 + 虚线 + 文字三重表达', '区分"对方自述""未经第三方验证"'),
    ]
    body = ''.join(f'<div class="st"><b>{a}</b><div>{b} &nbsp; <span style="color:var(--muted)">{c}</span>'
                   f'<br><small style="color:var(--muted)">{d}</small></div></div>' for a, b, c, d in rows)
    return f'<div class="states">{body}</div>'


def sec_judge():
    return f'''
<h3>V1 · 来源三态：任何信息必须一眼可辨来源</h3>
<div class="demo"><div class="grid3">
<div><div class="panel"><h4>你说的</h4><p>墨色实边。<br>你自己写下的判断、承诺、修改。</p></div>
<div class="card judgment" style="margin-top:12px"><h5>不做垫资与合资兜底。</h5>
<div class="when">你 · 2026-10-11 会议当场判断</div></div></div>
<div><div class="panel"><h4>AI 推的</h4><p>知识紫 + 虚线 +「AI 判断」。<br>模型推断绝不能冒充事实。</p></div>
<div class="card advice" style="margin-top:12px;border-left-style:dashed">
<div class="row1"><span>建议 · 依据 2 条</span><span><i>◇</i> AI 判断</span></div>
<h5>先索取开发板做零成本适配验证。</h5></div></div>
<div><div class="panel"><h4>原始材料</h4><p>灰底 + 引用样式。<br>来源原文，不做加工。</p></div>
<div class="quote" style="margin-top:12px">「服务器方案：4 颗一个 page，明年 3 月投片、9 月回片。」<br>
<small>录音第 4 段 · 对方自述 · 10-11</small></div></div>
</div></div>

<h3>V2 · 判断三要素：缺哪项显示"缺"，不留白</h3>
<div class="demo"><div class="lbl">判断卡（依据就地展开，不跳页）</div>
<div class="card judgment" style="max-width:660px">
<div class="row1"><span>判断 · 微纳核芯 3D 存算一体</span><span><i>◇</i> 你已确认</span></div>
<h5>服务器端短期难以成立：带宽与成本都不匹配现有客户的价格预期。</h5>
<div class="hr"></div>
<div class="ev">依据 3 条 · 点开就地展开</div>
<div class="unc">不确定性：性能与成本为对方自述，未经第三方验证</div>
<div class="when">2026-10-11 成立 · 尚未复核 · 标记待复核</div>
<details class="trace"><summary>依据与来源</summary><ul>
<li><span>会议录音第 4 段 · 对方自述</span><small>10-11</small></li>
<li><span>你的判断：价格敏感是硬约束</span><small>10-11</small></li>
<li><span>判断「服务器客户普遍价格敏感」</span><small>关联判断</small></li>
</ul></details></div>
<div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">
<span class="tag t-neu">◇ 待核对</span><span class="tag t-ok">✓ 已确认</span><span class="tag t-warn">↩ 已被推翻</span>
<span class="tag t-neu">依据：缺</span><span class="tag t-neu">不确定性：未标</span></div></div>

<h3>V3 · 建议的四种状态</h3>
<div class="demo"><div class="grid2">
<div><div class="card advice">
<div class="row1"><span>建议 · 依据 2 条</span><span><i>◇</i> AI 提议 · 等你决定</span></div>
<h5>先索取开发板做零成本适配验证，再进入商务流程。</h5>
<div class="btns"><span class="b pri">采纳</span><span class="b sec">改写</span><span class="b sec">否决</span><span class="b txt">稍后</span></div>
<details class="trace"><summary>为什么这么建议</summary><ul>
<li><span>10-11 判断：不接受垫资与合资兜底</span><small>点开</small></li>
<li><span>10-11 否决「直接见股东」</span><small>你的理由：优先级不对</small></li>
</ul></details></div>
<div class="card" style="margin-top:12px;border-left:3px solid var(--warning)">
<div class="row1"><span>建议 · 依据 0 条</span><span>通用建议</span></div>
<h5>可以同时推进三条客户线以提高命中率。</h5>
<div class="unc">这条没有你既有判断支撑，是通用建议 —— 不代表你过去的判断。</div></div></div>
<div><div class="card" style="border-left:3px solid var(--success)">
<div class="row1"><span>已采纳</span><span><i class="dot" style="background:var(--success)"></i>已生效 · 可撤销</span></div>
<h5>索取开发板做适配验证。</h5></div>
<div class="card" style="margin-top:12px;border-left:3px solid var(--action)">
<div class="row1"><span>已改写</span><span><i class="dot" style="background:var(--action)"></i>你改了什么看得见</span></div>
<h5>先索取开发板，同时核对公司主体与股权。</h5>
<div class="when">原建议：先索取开发板做零成本适配验证</div></div>
<div class="card rejected" style="margin-top:12px">
<div class="row1"><span>建议 · 已否决</span><span>不再推荐（除非有新证据）</span></div>
<h5>直接安排与股东方会面。</h5>
<div class="hr"></div>
<div class="when">你的理由：优先级不对，先看技术再谈股权 · 10-11 14:20</div></div></div>
</div></div>
'''


def sec_canvas():
    return '''
<h3>关系的两种线</h3>
<div class="demo"><div class="grid2">
<div><div class="panel"><h4>实线 · 明确引用或你已确认</h4>
<svg viewBox="0 0 320 60" style="width:100%;height:60px"><path d="M12 30h120" stroke="#626C78" stroke-width="1.6" fill="none"/>
<text x="12" y="18" font-size="11" fill="#626C78">明确引用</text>
<path d="M170 30h120" stroke="#7555A1" stroke-width="1.6" stroke-dasharray="6 6" fill="none"/>
<text x="170" y="18" font-size="11" fill="#7555A1">AI 待确认</text></svg></div></div>
<div><div class="panel"><h4>按缩放分层（强制）</h4>
<p>&lt;60%：名称 + 类型<br>60–110%：补状态与计数<br>&gt;110%：按需显示关系文字</p></div></div>
</div>
<div class="layers">
<div class="layer"><i style="height:56px"></i><small>&lt;60% · 只有名称与类型</small></div>
<div class="layer"><i style="height:86px"></i><small>60–110% · 状态与计数</small></div>
<div class="layer"><i style="height:118px"></i><small>&gt;110% · 关系文字</small></div>
</div></div>
'''


def sec_share():
    return '''
<div class="demo"><div class="lbl">导出前必须把剔除的说出来</div>
<div class="card" style="max-width:620px">
<div class="row1"><span>导出为可分享文档</span><span>将分享 3 条 · 剔除 1 条仅自己</span></div>
<div class="hr"></div>
<div style="font-size:12.5px;line-height:2.1">
<div><span class="tag t-ok">✓</span> 微纳核芯服务器端短期难成立 <small style="color:var(--muted)">· 含依据 3 条 · 10-11</small></div>
<div><span class="tag t-ok">✓</span> 我方不做垫资与合资兜底 <small style="color:var(--muted)">· 含依据 2 条 · 10-11</small></div>
<div><span class="tag t-ok">✓</span> 需核对长鑫合作真实性 <small style="color:var(--muted)">· 待核对 · 10-11</small></div>
<div style="color:var(--muted)"><span class="tag t-neu">–</span> <s>与股东方的沟通口径</s>
<small>· 已标记仅自己，未包含</small></div></div>
<div class="btns"><span class="b pri">导出</span><span class="b txt">取消</span></div></div>
<p style="font-size:12.5px">导出的每一份都自带：判断、依据、不确定性、什么时候成立、以及"这是谁在什么时候的判断"。</p></div>
'''


CLAUSES = [
    ('V1 来源三态', '任何信息必须一眼可辨来源：你说的（墨色实边）／AI 推的（知识紫 + 虚线 +「AI 判断」）／原始材料（灰底 + 引用样式）', '§9'),
    ('V2 判断三要素', '判断必须同时呈现依据（可点、就地展开、显示条数与出处）+ 不确定性（赭色文字）+ 什么时候成立（灰墨小字）；缺哪项显示"缺"。状态符号 ◇ 待核对 / ✓ 已确认 / ↩ 已被推翻', '§9'),
    ('V3 建议的四种状态', '待你决定（工作蓝细线）／已采纳（绿点）／已改写（蓝点 + 显示改了什么）／已否决（灰墨 + 你的理由 + 卡片不消失）。建议卡固定结构：建议 → 依据 → 不确定性 → 四个回应 → 可展开的「为什么这么建议」', '§9'),
    ('V4 安静靠秩序', '允许高信息密度；分层只用对齐、间距、字重、雾线，不靠框与色块堆叠；每屏最多一幅简笔画；每个视图最多一个主色按钮', '§04 §07'),
    ('V5 新增准入', '新颜色必须对应一个全新的真实状态，且必须同时有文字与符号；新图标必须证明现有图标无法表达并登记入册', '§02 §05 §15'),
    ('V6 不越权改主题', '消费宿主主题语义变量（目标前缀 --dsw-alias-*，具体变量名须核实后写入 §13）；禁止 !important 覆盖', '§13 §15'),
    ('V7 分享形态', '导出件必须自带出处与时间；导出前显示"将分享 N 条 · 剔除 M 条仅自己"；分享默认仅自己，逐条改', '§11'),
    ('V8 边界（禁止清单）', '禁止：无回执的假成功（乐观 UI）· 装饰性动效 · 情绪化提示（红点／感叹号催促／成功撒花）· 颜色单独承担判断 · 无上限满绘画布', '§08 §15'),
    ('V9 精致与一致性', '同一控件全站唯一实现；同一层级同一套字阶（数字等宽）；间距只用标尺；每控件四态齐全；收口清单（无 emoji 图标、无无意义渐变阴影、文字不截成省略号、边缘不裁切、中英留空、长名称有换行规则）；全部进门禁', '§07 §12 §15'),
]

GATES = [
    ('色值', '代码内字面色值 = 0'), ('间距', '标尺外像素值 = 0'), ('字号', '字阶外字号 = 0'),
    ('组件唯一', '同类实现个数 ≤ 1'), ('四态', '每个控件默认／悬停／聚焦／禁用齐全'),
    ('对比度', '明暗两套逐文本节点，0 处不达标'), ('页面溢出', '1440 / 390 两档无横向溢出'),
    ('弹窗', '居中 · Escape · 焦点恢复 · 背景不可操作 · 未保存保护'),
    ('硬编码覆盖', '!important 覆盖色 = 0'), ('图标与简笔画', '全部在册，无 emoji 图标'),
    ('状态文字', '绿点／赭色／虚线旁必须有对应文字'), ('精确重建', '冻结原型切片与基线一致'),
]

VERSIONS = [
    ('v0.1', '2026-10-13', '纸上秩序首版（design-system/设计手册.html）：纸白／墨线／工作蓝、32 图标、8 简笔画、组件与状态规范'),
    ('**v1.0**', '2026-10-13', '纳入宪章体系并冻结：六品味 → 视觉后果映射；补齐 V1–V9 权威定义（原方案缺 V4／V8）；新增判断与建议的视觉语言；V9 精致与一致性进 12 项门禁；修正间距违规（卡片内边距 22 → 24）'),
]

# ---------------- 组装 ----------------
toc_html = ''.join(
    f'<a href="#{anchor}"{" class=\"on\"" if i == 0 else ""}><em>{no}</em>{label}</a>'
    for i, (anchor, no, label) in enumerate(TOC))
clauses_html = ''.join(f'<tr><td>{a}</td><td>{b}</td><td>{c}</td></tr>' for a, b, c in CLAUSES)
gates_html = ''.join(f'<tr><td>{i+1}</td><td>{a}</td><td>{b}</td></tr>' for i, (a, b) in enumerate(GATES))
versions_html = ''.join(f'<tr><td>{a}</td><td>{b}</td><td>{c}</td></tr>' for a, b, c in VERSIONS)

HTML = f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>个人工作台 · VI 规范 {VERSION}（纸上秩序）</title>
<style>{css}</style></head><body>

<header class="top"><div class="brand">{mark}个人工作台<span>VI 规范 · 纸上秩序 {VERSION}</span></div>
<div class="top-actions"><button id="theme" aria-pressed="false">深色预览</button><button id="print">打印</button></div></header>

<nav class="toc" aria-label="目录"><small>VISUAL IDENTITY</small>{toc_html}
<footer>唯一权威版本<br>修订请改 build-vi-spec.py<br>并递增版本号</footer></nav>

<main>

<section id="rel">
<div class="eyebrow">00 / 与宪章的关系</div>
<h1>VI 不是审美选择，是品味的物质化</h1>
<p class="lead">本规范由《顶层宪章》第六条推出。宪章九条是立场，本规范是它的视觉投影 —— 视觉上的每一个取舍，都能指回某一条品味。<b>指不回去的视觉元素不做。</b></p>
<div class="tblwrap"><table><thead><tr><th>品味（宪章第六条）</th><th>视觉后果</th></tr></thead><tbody>
<tr><td>诚实</td><td>状态不靠颜色单独表达；未接入就是灰字说明；推断用虚线 + 文字</td></tr>
<tr><td>安静</td><td>无红点、无夺目动效、无装饰性渐变；信息在场但不喧哗</td></tr>
<tr><td>克制</td><td>一个视图一个主色按钮；不新增颜色、图标、容器</td></tr>
<tr><td>有重量</td><td>回执与撤销常驻；过渡 120–220ms、位移 ≤ 8px</td></tr>
<tr><td>耐用</td><td>系统字体、可编辑 SVG、CSS 变量；不绑死宿主实现</td></tr>
<tr><td>精致</td><td>同一控件唯一实现；同层级同字阶；间距只用标尺；四态齐全</td></tr>
</tbody></table></div>
<div class="key">v0.1 评估结论，本版已补齐：原方案对"品味"符合度高，但对宪章<b>第三条（判断是一等公民）</b>与<b>第四条（建议必须闭环）</b>没有对应视觉语言 —— 那是"事务型工作台"的 VI。<small>本版通过 §9 与 §14 的 V1–V3 补齐，并把 V9（精致）纳入 §15 的 12 项机械门禁。</small></div>
</section>

<section id="mark">
<div class="eyebrow">01 / 标识</div>
<h2>连接之窗</h2>
<div class="mark-lockup">{mark}<div><b>个人工作台</b><small>PERSONAL WORKSTATION</small></div></div>
<div class="mark-row">
<div class="mark-tile m-light">{mark}<span>标准墨色 / 浅色底</span></div>
<div class="mark-tile m-blue">{mark_rev}<span>反白 / 品牌蓝底</span></div>
<div class="mark-tile m-dark">{mark_rev}<span>反白 / 深色底</span></div>
</div>
<div class="grid2">
<div class="panel"><h4>构造</h4><p>52 × 52 网格，主线宽 2.4。左下的开放边界代表工作区；一条折线从节点向右上展开，表达工作推进与关系延展。</p></div>
<div class="panel"><h4>用法与禁止</h4><p>安全区 ≥ 8/52 标识宽；数字端最小 24px；字标 24px / 500；标识与字标间距 12px。<br><b>禁止</b>拉伸、旋转、渐变填充、发光、加阴影。小于 24px 时用图标简化版。</p></div>
</div>
<div class="demo"><div class="lbl">应用图标（插件入口）</div><div style="display:flex;align-items:center;gap:22px">
<span style="display:inline-block;width:72px">{app_icon}</span><span style="width:48px;display:inline-block">{app_icon}</span>
<span style="width:32px;display:inline-block">{app_icon}</span>
<small style="color:var(--muted)">64 / 48 / 32 px</small></div></div>
</section>

<section id="color">
<div class="eyebrow">02 / 色彩</div>
<h2>大部分留白，小部分有色</h2>
<p class="lead">唯一色值来源是 <code>design-system/tokens.json</code>。<b>代码里不得出现字面色值。</b>常规页面配比建议：中性空间 ≈85%、文字与线条 ≈10%、行动色 ≈5%。点击色块复制色值。</p>
{sec_swatches()}
<div class="grid2">
<div class="panel"><h4>使用规则</h4><p>蓝色只承担<b>行动与聚焦</b>；其余颜色只表达<b>真实状态或对象类型</b>。<br>
<b>颜色不得单独承担判断</b>：绿点必配"已完成"，赭色必配原因文字，虚线必配"AI 判断"。</p></div>
<div class="panel"><h4>对象与状态编码</h4><p>
<span class="tag t-act">项目 · 蓝</span> <span class="tag t-ok">任务 · 绿</span>
<span class="tag t-ai">知识／记忆 · 紫</span> <span class="tag t-warn">事务 · 赭</span><br style="line-height:2.4">
<span class="tag t-ok">✓ 已完成</span> <span class="tag t-warn">Ⅱ 等待输入</span>
<span class="tag t-bad">! 执行失败</span> <span class="tag t-ai">◇ AI 待确认</span></p></div>
</div>
<div class="key warn">V5 新增准入：<b>新颜色必须对应一个全新的真实状态</b>，且必须同时有文字与符号。<small>不允许为了好看而加色。</small></div>
</section>

<section id="type">
<div class="eyebrow">03 / 字体与排版</div>
<h2>安静的字，清楚的层次</h2>
<p class="lead">字体栈 <code>-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif</code>，数据与路径用系统等宽。<b>不引入外部字体文件</b>（耐用性）。字阶是唯一一套，不得新增字号。</p>
{sec_type()}
<div class="grid2">
<div class="panel"><h4>硬规则</h4><p>数字一律等宽（<code>tabular-nums</code>）。产品页<b>不设大号宣传句</b>，页头＝面包屑 + 一行小字。同一层级必须用同一字号、行高、字重。</p></div>
<div class="panel"><h4>收口清单</h4><p>中英文之间留空；中文标点用全角；文字不得截成省略号（要么折行，要么可展开全文）；长名称有确定换行规则（默认最多两行）。</p></div>
</div>
</section>

<section id="space">
<div class="eyebrow">04 / 间距 · 圆角 · 层</div>
<h2>只用一套标尺</h2>
<p class="lead"><b>标尺外的像素值不允许出现。</b>不随手写 18px、22px、27px —— 这既是精致，也是门禁。</p>
{sec_space()}
<div class="grid3">
<div class="panel"><h4>分层</h4><p>边框 1px；<b>只有浮层使用明显阴影</b>，其余靠边框与留白分层。一块内容最多两层容器嵌套。</p></div>
<div class="panel"><h4>密度</h4><p>常规行 48 · 紧凑行 40 · 移动点击区 ≥ 44 × 44。<br><b>安静 ≠ 稀疏</b>（V4）：允许高密度，靠秩序而非空旷。</p></div>
<div class="panel"><h4>布局</h4><p>侧栏 204 · 顶栏 72–80 · 页边距 32 · 弹窗宽 760（最高 88vh/dvh）· 桌面 12 栏栏间距 16。</p></div>
</div>
</section>

<section id="icon">
<div class="eyebrow">05 / 图标</div>
<h2>为操作服务</h2>
<p class="lead">24 × 24 网格 · 1.6px 线宽 · 圆端点圆转角 · 显示 16 / 20 / 24px。选中态由底色与文字补充，不只把线条加粗。新增图标必须证明现有图标无法表达并登记入册（V5）。</p>
{sec_icons()}
<div class="key bad">禁止用 emoji 当图标。禁止每个图标换一种线宽或圆角。</div>
</section>

<section id="art">
<div class="eyebrow">06 / 简笔画</div>
<h2>为理解服务</h2>
<p class="lead">240 × 160 母版 · 2px 线宽 · 墨色 + 1 个蓝色强调 · 留白 ≥ 50%。功能页每屏最多一幅（V4）；建议宽 96–180px，空态 160–220px。</p>
{sec_arts()}
<div class="key warn">禁止：表情包、拟人机器人、复杂透视、随机抖线、盖住真实数据。<small>插画是辅助理解，不是装饰。</small></div>
</section>

<section id="comp">
<div class="eyebrow">07 / 组件唯一来源</div>
<h2>每个控件全站只有一个实现</h2>
<p class="lead">V9 精致的核心。同类实现个数 &gt; 1 即门禁失败 —— 不允许"这页这样、那页那样"。</p>
{sec_components()}
<div class="key">已登记组件（新增须登记）：按钮 · 输入/下拉/文本域 · 居中弹窗 · 卡片 · 列表行/看板卡 · 空态 · 反馈条 · 标签 · 撤销条。
<small><b>没做状态就不算做完</b>：默认／悬停／聚焦／禁用四态齐全。</small></div>
</section>

<section id="state">
<div class="eyebrow">08 / 状态与反馈</div>
<h2>六种状态，各有固定说法与固定样子</h2>
<p class="lead">让状态无法临时发挥。同时明确一条边界：<b>即时生效 ≠ 乐观 UI</b> —— 点击立刻响应允许；收到回执前显示"已保存"禁止。</p>
{sec_states()}
<div class="key warn">颜色永远不单独承担判断。<small>这也让界面在十年后、在色觉差异下依然可读（宪章第七条）。</small></div>
</section>

<section id="judge">
<div class="eyebrow">09 / 判断与建议</div>
<h2>V1–V3：本版新增的视觉语言</h2>
<p class="lead">原方案缺的正是这一节 —— 宪章第三条与第四条的视觉表达。全部只用现有 VI 元素，没有新增颜色与图标族。</p>
{sec_judge()}
</section>

<section id="canvas">
<div class="eyebrow">10 / 关系与画布</div>
<h2>用线的状态，表达知识的边界</h2>
{sec_canvas()}
<div class="key">画布必须保留：全局复位 · 查找聚焦 · 全屏 · 关系列表（等价阅读路径）。节点标题按宽度折行最多两行，全文进 <code>title</code> 与读屏标签，<b>不得溢出色块</b>。</div>
</section>

<section id="share">
<div class="eyebrow">11 / 分享形态</div>
<h2>V7：出处跟着判断一起走</h2>
{sec_share()}
</section>

<section id="a11y">
<div class="eyebrow">12 / 无障碍与多端</div>
<h2>十年后还看得懂</h2>
<div class="grid2">
<div class="panel"><h4>对比度与焦点</h4><p>正文/白底 ≥ 4.5:1；关键边界与聚焦环 ≥ 3:1；焦点环 3px；Tab 顺序跟随视觉布局；焦点始终可见；弹窗关闭后焦点返回触发点。</p></div>
<div class="panel"><h4>可读性</h4><p>真实按钮与表单标签；画布同时提供关系列表与节点名称；状态变化用 <code>aria-live</code> 宣告；200% 放大下操作可达；<code>prefers-reduced-motion</code> 下动效即时完成。</p></div>
</div>
<div class="tblwrap"><table><thead><tr><th>断点</th><th>行为</th></tr></thead><tbody>
<tr><td>≥ 1200px</td><td>全量布局：204px 侧栏保留全部入口</td></tr>
<tr><td>701–1199px</td><td>双列；顶栏可分两行；项目卡两列；内容区允许横向滚动</td></tr>
<tr><td>≤ 700px</td><td>单列；导航折为顶部紧凑入口（<b>入口不减少</b>）；轻指标双列；点击区 ≥ 44px；画布独立滚动缩放并保留全局与详情按钮</td></tr>
</tbody></table></div>
</section>

<section id="host">
<div class="eyebrow">13 / 宿主主题</div>
<h2>V6：不越权改主题</h2>
<div class="key warn">插件<b>必须消费宿主主题语义变量</b>，不自行发明一套主题映射。
<small>目标前缀 <code>--dsw-alias-*</code>（来自既有审计记录）。<b>具体变量名必须在宿主实现中核实后写入本节</b>（核实方式：在真实页面枚举 <code>--dsw-*</code> 变量，或读取宿主主题样式表）。<b>核实之前不得声称"已消费宿主主题"。</b><br><br>
迁移期允许保留 <code>--ws-*</code> 作为变量层，但最终色值来源必须是宿主语义变量 + tokens。<br>
<b>禁止用 <code>!important</code> 覆盖</b>原型内联色（实现层现有 3 处须清理）。</small></div>
<p>本页右上角的"深色预览"演示的是变量层效果；正式插件接入宿主主题后，深浅切换应交由宿主控制。</p>
</section>

<section id="clauses">
<div class="eyebrow">14 / 增补条款</div>
<h2>V1–V9 权威定义</h2>
<p class="lead">本表是 V1–V9 的<b>唯一权威定义</b>，其他小节只做展开，冲突以本表为准。</p>
<div class="tblwrap"><table><thead><tr><th>条款</th><th>规定</th><th>展开位置</th></tr></thead><tbody>{clauses_html}</tbody></table></div>
</section>

<section id="gate">
<div class="eyebrow">15 / 门禁</div>
<h2>12 项机械检查，不靠人眼</h2>
<p class="lead">全部并入 <code>npm run verify</code>；建议新增 <code>audit:craft</code>（一致性）。精致不靠自觉维持，靠门禁。</p>
<div class="tblwrap"><table><thead><tr><th>#</th><th>检查</th><th>判据</th></tr></thead><tbody>{gates_html}</tbody></table></div>
<div class="key warn">代价明码标价：精致会拖慢功能推进 —— 每个新功能多走三步（复用已有组件、补齐四态、对齐标尺）。<small>接受精致，就等于接受推进变慢。两者不能都要。</small></div>
</section>

<section id="assets">
<div class="eyebrow">16 / 交付资产与版本</div>
<h2>资产清单与修订方式</h2>
<div class="tblwrap"><table><thead><tr><th>资产</th><th>位置</th></tr></thead><tbody>
<tr><td>设计变量（唯一色值来源）</td><td><code>design-system/tokens.json</code> · <code>tokens.css</code></td></tr>
<tr><td>标识</td><td><code>assets/mark.svg</code> · <code>mark-blue.svg</code> · <code>mark-mono.svg</code> · <code>mark-reverse.svg</code> · <code>app-icon.svg</code> · <code>wordmark.svg</code></td></tr>
<tr><td>图标 32 个 / 简笔画 8 个</td><td><code>assets/icons/*.svg</code> · <code>assets/illustrations/*.svg</code></td></tr>
<tr><td>登记表（未登记即违规）</td><td><code>spec/registry.json</code></td></tr>
<tr><td>文字版（供开发与门禁引用）</td><td><code>spec/02-VI规范-v1.0.md</code></td></tr>
</tbody></table></div>
<h3>版本记录</h3>
<div class="tblwrap"><table><thead><tr><th>版本</th><th>日期</th><th>变更</th></tr></thead><tbody>{versions_html}</tbody></table></div>
<div class="key"><b>修订方式</b>：本页由 <code>spec/build-vi-spec.py</code> 生成 —— <b>要改版本请改脚本并递增 <code>VERSION</code>，不要手改产物。</b>
<small>这样保证：色值与标尺永远来自 tokens；图标与简笔画永远来自 assets；成品永远自包含（不依赖旁边文件，DSH 预览可正常显示）。</small></div>
</section>

<div class="foot"><span>个人工作台 · VI 规范 · 纸上秩序 {VERSION}</span><span>依据《顶层宪章》第六条 · 与 spec/registry.json 同步</span></div>
</main>

<script>
const $=s=>document.querySelector(s);let toastTimer;
function notify(t){{const el=$('#toast');el.textContent=t;clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.textContent='',2600)}}
$('#theme').onclick=()=>{{const on=document.documentElement.dataset.theme!=='dark';
document.documentElement.dataset.theme=on?'dark':'light';$('#theme').textContent=on?'浅色预览':'深色预览';$('#theme').setAttribute('aria-pressed',on)}};
$('#print').onclick=()=>window.print();
document.querySelectorAll('[data-copy]').forEach(b=>b.onclick=async()=>{{try{{await navigator.clipboard.writeText(b.dataset.copy);notify('已复制 '+b.dataset.copy)}}
catch{{notify('色值：'+b.dataset.copy+'，可手动选取复制')}}}});
const links=[...document.querySelectorAll('.toc a')];
const obs=new IntersectionObserver(es=>{{es.forEach(e=>{{if(!e.isIntersecting)return;
links.forEach(a=>{{const on=a.hash==='#'+e.target.id;a.classList.toggle('on',on);
if(on)a.setAttribute('aria-current','true');else a.removeAttribute('aria-current')}})}})}},{{rootMargin:'-15% 0px -70% 0px'}});
document.querySelectorAll('main>section').forEach(s=>obs.observe(s));
</script>
<div id="toast" style="position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--ink);color:var(--surface);padding:11px 18px;border-radius:9px;font-size:12px;z-index:50" role="status" aria-live="polite"></div>
</body></html>
'''

OUT.write_text(HTML, encoding='utf8')
kb = len(HTML.encode('utf8')) / 1024
print(f'已生成 {OUT.relative_to(ROOT)}（{kb:.1f} KB，自包含，内联 {len(icons)} 图标 / {len(arts)} 简笔画）')
