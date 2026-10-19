#!/usr/bin/env python3
"""把审计报告从 Markdown 生成**自包含 HTML**（用户要求规范/报告以可视化 HTML 交付，可直接转发）。

做法与 spec/build-vi-spec.py 一致：改内容改 Markdown，改样式改本脚本，不手改产物。
截图以 base64 内联，文件不依赖旁边任何资源。

用法：python3 prototype/build-audit-html.py
"""
from pathlib import Path
import base64
import html
import re

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / '审计-用户点名问题-20261014.md'
OUTPUT = ROOT / '审计-用户点名问题-20261014.html'
SHOTS = ROOT / 'prototype' / 'screenshots'
TITLE = '个人工作台 · 用户点名问题全量审计（2026-10-14）'

# 报告中要内联的图片：Markdown 里的相对路径 → 实际文件
FIGURES = {
    'workstation/prototype/screenshots/pages-before-fontfix/01-desktop-home.png': SHOTS / 'pages-before-fontfix' / '01-desktop-home.png',
    'workstation/prototype/screenshots/pages/01-desktop-home.png': SHOTS / 'pages' / '01-desktop-home.png',
    'workstation/prototype/screenshots/before-fontfix/06-settings.png': SHOTS / 'before-fontfix' / '06-settings.png',
    'workstation/prototype/screenshots/current/06-settings.png': SHOTS / 'current' / '06-settings.png',
    'workstation/prototype/screenshots/current/01-create-menu.png': SHOTS / 'current' / '01-create-menu.png',
    'workstation/prototype/screenshots/current/02-new-project-top.png': SHOTS / 'current' / '02-new-project-top.png',
}


def inline(text: str) -> str:
    text = html.escape(text, quote=False)
    text = re.sub(r'`([^`]+)`', r'<code>\1</code>', text)
    text = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', text)
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', text)
    return text


def figure(path: Path, caption: str) -> str:
    data = base64.b64encode(path.read_bytes()).decode('ascii')
    return f'<figure><img alt="{html.escape(caption)}" src="data:image/png;base64,{data}"><figcaption>{html.escape(caption)}</figcaption></figure>'


def convert(markdown: str) -> str:
    out, lines, index = [], markdown.split('\n'), 0
    while index < len(lines):
        line = lines[index]
        # 图片段落 → 内联图表
        image = re.match(r'^!\[([^\]]*)\]\(([^)]+)\)$', line.strip())
        if image:
            caption, path = image.group(1), image.group(2)
            # Markdown 里是两行一组（前=修复前/后=修复后），这里各自成图，靠 caption 区分
            if path in FIGURES:
                out.append(figure(FIGURES[path], caption))
            index += 1
            continue
        if line.startswith('|') and index + 1 < len(lines) and set(lines[index + 1].replace('|', '').strip()) <= set('-: '):
            head = [cell.strip() for cell in line.strip('|').split('|')]
            index += 2
            body = []
            while index < len(lines) and lines[index].startswith('|'):
                body.append([cell.strip() for cell in lines[index].strip('|').split('|')])
                index += 1
            out.append('<table><thead><tr>' + ''.join(f'<th>{inline(cell)}</th>' for cell in head) + '</tr></thead><tbody>'
                       + ''.join('<tr>' + ''.join(f'<td>{inline(cell)}</td>' for cell in row) + '</tr>' for row in body)
                       + '</tbody></table>')
            continue
        heading = re.match(r'^(#{1,4})\s+(.*)$', line)
        if heading:
            level = len(heading.group(1))
            out.append(f'<h{level}>{inline(heading.group(2))}</h{level}>')
            index += 1
            continue
        if line.strip() == '---':
            out.append('<hr>')
            index += 1
            continue
        if line.startswith(('- ', '* ')):
            items = []
            while index < len(lines) and lines[index].startswith(('- ', '* ')):
                items.append(f'<li>{inline(lines[index][2:])}</li>')
                index += 1
            out.append('<ul>' + ''.join(items) + '</ul>')
            continue
        if line.strip().startswith('```'):
            block, index = [], index + 1
            while index < len(lines) and not lines[index].strip().startswith('```'):
                block.append(html.escape(lines[index]))
                index += 1
            index += 1
            out.append('<pre>' + '\n'.join(block) + '</pre>')
            continue
        if not line.strip():
            index += 1
            continue
        out.append(f'<p>{inline(line)}</p>')
        index += 1
    return '\n'.join(out)


CSS = """
:root{--paper:#F8F9F7;--surface:#fff;--ink:#252A31;--muted:#626C78;--line:#DCE1E5;--action:#315ED0;
--warn:#8A601D;--warn-soft:#FBF4E6;--ok:#28735B;--ok-soft:#EDF6F1}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);
font:14px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:960px;margin:0 auto;padding:48px 32px 96px}
h1{font-size:32px;line-height:1.3;font-weight:600;letter-spacing:-.5px;margin:0 0 8px}
h2{font-size:22px;font-weight:600;margin:48px 0 12px;padding-top:24px;border-top:1px solid var(--line)}
h3{font-size:18px;font-weight:600;margin:32px 0 8px}
h4{font-size:15px;font-weight:600;margin:24px 0 6px}
p{margin:12px 0}
ul{margin:12px 0;padding-left:22px}
li{margin:6px 0}
code{background:var(--surface);border:1px solid var(--line);border-radius:4px;padding:1px 5px;
font:12px/1.6 ui-monospace,SFMono-Regular,monospace}
pre{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px 20px;overflow:auto;
font:12px/1.7 ui-monospace,SFMono-Regular,monospace}
table{width:100%;border-collapse:collapse;margin:16px 0;background:var(--surface);
border:1px solid var(--line);border-radius:12px;overflow:hidden}
th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--line);font-size:13px;vertical-align:top}
th{background:var(--paper);font-weight:600;font-size:12px;color:var(--muted)}
tr:last-child td{border-bottom:0}
figure{margin:20px 0}
figure img{width:100%;display:block;border:1px solid var(--line);border-radius:12px}
figcaption{margin-top:8px;color:var(--muted);font-size:12px}
hr{border:0;border-top:1px solid var(--line);margin:36px 0}
strong{font-weight:600}
blockquote{margin:16px 0;padding:12px 20px;border-left:2px solid var(--action);color:var(--muted);background:var(--surface)}
a{color:var(--action)}
"""


def main() -> None:
    body = convert(SOURCE.read_text())
    OUTPUT.write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f'<title>{html.escape(TITLE)}</title><style>{CSS}</style></head>'
        f'<body><main>{body}</main></body></html>'
    )
    size = OUTPUT.stat().st_size
    print(f'已生成 {OUTPUT.name}（自包含，{size // 1024} KB，内联 {len(FIGURES)} 张截图）')


if __name__ == '__main__':
    main()
