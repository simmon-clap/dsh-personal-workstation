import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from '../dev-deps.mjs';
import {renderMarkdown,markdownHeadings,readerHtml} from '../prototype/markdown.mjs';

// 用真实 DOM 判断"有没有变成标签"，而不是拿正则去猜转义后的文本。
const dom=html=>new JSDOM('<div id="r">'+html+'</div>').window.document.querySelector('#r');

// 体检 A5：材料详情过去把正文塞进一个 white-space:pre-wrap 的框里——没有 markdown、没有目录、不能全屏。
// 这里锁住渲染器的三条底线：①不可信内容安全渲染；②会议纪要这类纯文本换行不能丢；③目录与正文锚点一致。

test('untrusted content is escaped before markdown ever runs',()=>{
 const {html}=renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>');
 const root=dom(html);
 assert.equal(root.querySelectorAll('script,img,iframe,style').length,0,'原文里的 HTML 必须被当成文字，不能变成标签');
 for(const node of root.querySelectorAll('*'))for(const attribute of node.attributes)assert.doesNotMatch(attribute.name,/^on/i,'不得出现任何内联事件属性');
 assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('links only accept http(s); anything else stays plain text',()=>{
 const {html}=renderMarkdown('[官网](https://example.com/a?b=1) 与 [点我](javascript:alert(1)) 与 [内网](/etc/passwd)');
 assert.match(html,/<a href="https:\/\/example\.com\/a\?b=1" target="_blank" rel="noopener noreferrer">官网<\/a>/);
 const root=dom(html);
 assert.equal(root.querySelectorAll('a').length,1,'只允许一个 http(s) 链接');
 for(const anchor of root.querySelectorAll('a'))assert.doesNotMatch(anchor.getAttribute('href'),/^javascript:/i,'javascript: 不能进 href');
 assert.match(html,/\[点我\]\(javascript:alert\(1\)\)/,'不许链接的按原文显示');
 assert.match(html,/\[内网\]\(\/etc\/passwd\)/,'相对路径不猜成外链');
});

test('plain multi-line meeting notes keep every line (the old box was pre-wrap)',()=>{
 const {html}=renderMarkdown('# 会议纪要\n一、试点范围：联合验证\n二、负责人：伙伴 A');
 assert.match(html,/<h3 data-heading="md-h1">会议纪要<\/h3>/);
 assert.match(html,/<p>一、试点范围：联合验证<br>二、负责人：伙伴 A<\/p>/,'普通换行必须保留，否则纪要会被挤成一行');
});

test('headings produce a table of contents whose anchors match the body',()=>{
 const note='# 一、会议信息\n## 1.1 时间地点\n正文\n## 1.2 参会人\n正文\n# 二、结论';
 const {html,headings}=renderMarkdown(note);
 assert.deepEqual(headings.map(item=>item.title),['一、会议信息','1.1 时间地点','1.2 参会人','二、结论']);
 assert.deepEqual(headings.map(item=>item.id),['md-h1','md-h2','md-h3','md-h4']);
 for(const heading of headings)assert.match(html,new RegExp('data-heading="'+heading.id+'"'),'目录锚点必须真的存在于正文');
 assert.deepEqual(markdownHeadings(note),headings,'导出给目录用的抽取结果必须与渲染一致');
});

test('lists, quotes, rules and fenced code render without breaking the layout',()=>{
 const {html}=renderMarkdown('- 第一项\n- 第二项\n1. 甲\n2. 乙\n> 引用一行\n---\n```js\nconst a=1<2;\n```');
 assert.match(html,/<ul><li>第一项<\/li><li>第二项<\/li><\/ul>/);
 assert.match(html,/<ol><li>甲<\/li><li>乙<\/li><\/ol>/);
 assert.match(html,/<blockquote>引用一行<\/blockquote>/);
 assert.match(html,/<hr>/);
 assert.match(html,/<pre data-code="js">const a=1&lt;2;<\/pre>/,'代码块要转义，且不能被当成 markdown');
});

test('inline emphasis and code are rendered, and code content is never re-parsed',()=>{
 const {html}=renderMarkdown('**重点** 与 *斜体* 与 `a*b_c`');
 assert.match(html,/<strong>重点<\/strong>/);
 assert.match(html,/<em>斜体<\/em>/);
 assert.match(html,/<code>a\*b_c<\/code>/,'行内代码里的 * 与 _ 不该被当成强调');
});

test('the reader shell shows a table of contents only when it helps, and always gives a scrollable body',()=>{
 const many=readerHtml('# 一\n## 1.1\n## 1.2');
 assert.match(many,/data-mdtoc="1"/,'两个以上标题就该给目录');
 assert.match(many,/data-mdgoto="md-h2"/);
 const one=readerHtml('没有标题的正文');
 assert.doesNotMatch(one,/data-mdtoc/,'只有一个标题时目录是多余的');
 assert.match(one,/data-mdbody="1"/);
 assert.match(readerHtml('').html??readerHtml(''),/data-mdbody/);
});
