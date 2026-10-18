import {escapeHtml as esc} from './project-render.mjs';

/** 材料详情的内嵌阅读器用的极小 markdown 渲染（体检 A5）。
 *
 *  为什么自己写而不是引库：整个工作台只发原型模块与 VI 资源，没有打包步骤，
 *  引第三方 markdown 库会引入新的发布面与供应链；这里要的能力只是"会议纪要能读"。
 *
 *  安全边界（PRD v1.1 IN-AC-10「客户材料与 HTML 按不可信内容安全渲染」）：
 *  1. **先整体转义，再套 markdown**——原文里的 `<script>` 永远不会变成标签；
 *  2. 链接只认 http/https，`javascript:` 之类只当普通文字，链接一律 rel="noopener noreferrer" target="_blank"；
 *  3. 不解析内联 HTML，不做任何 DOM 注入（调用方用 innerHTML 得到的都是本函数生成的标签）。
 *
 *  兼容性取舍：单个换行保留为 <br>。原来的详情框是 white-space:pre-wrap，
 *  没有 markdown 的纯文本（大量真实会议纪要就是这样）也必须一行一行地读。 */

const headingLevels={1:'h3',2:'h4',3:'h5',4:'h6',5:'h6',6:'h6'};
const slug=index=>'md-h'+index;

function inline(text){
 let out=esc(text);
 // 行内代码优先：里面的 * _ [ 都不该再被当成 markdown。
 const codes=[];
 out=out.replace(/`([^`]+)`/g,(_,code)=>{codes.push(code);return '\u0000'+(codes.length-1)+'\u0000'});
 out=out.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
 out=out.replace(/(^|[^*])\*([^*\n]+)\*/g,'$1<em>$2</em>');
 out=out.replace(/(^|[^_])_([^_\n]+)_/g,'$1<em>$2</em>');
 out=out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,(match,label,href)=>{
  const url=/^https?:\/\//i.test(href)?href:(/^www\./i.test(href)?'https://'+href:'');
  if(!url)return match; // 非 http(s) 一律不链接，保持原文（含 javascript: 之类）
  return '<a href="'+url+'" target="_blank" rel="noopener noreferrer">'+label+'</a>';
 });
 out=out.replace(/\u0000(\d+)\u0000/g,(_,index)=>'<code>'+codes[Number(index)]+'</code>');
 return out;
}

/** 把标题抽出来做目录：返回 [{level,title,id}]，id 与渲染出来的标题锚点一致。 */
export function markdownHeadings(text){
 const lines=String(text??'').split('\n');
 const headings=[];
 let inFence=false,index=0;
 for(const line of lines){
  if(/^\s*```/.test(line)){inFence=!inFence;continue}
  if(inFence)continue;
  const match=/^(#{1,6})\s+(.*)$/.exec(line);
  if(!match)continue;
  index+=1;
  headings.push({level:match[1].length,title:match[2].trim(),id:slug(index)});
 }
 return headings;
}

/** @returns {{html:string,headings:Array<{level:number,title:string,id:string}>}} */
export function renderMarkdown(text){
 const lines=String(text??'').replace(/\r\n?/g,'\n').split('\n');
 const out=[],headings=[];
 let paragraph=[],list=null,quote=[],fence=null,fenceLines=[];
 const flushParagraph=()=>{if(paragraph.length){out.push('<p>'+paragraph.map(inline).join('<br>')+'</p>');paragraph=[]}};
 const flushList=()=>{if(list){out.push('<'+list.tag+'>'+list.items.map(item=>'<li>'+inline(item)+'</li>').join('')+'</'+list.tag+'>');list=null}};
 const flushQuote=()=>{if(quote.length){out.push('<blockquote>'+quote.map(inline).join('<br>')+'</blockquote>');quote=[]}};
 const flushAll=()=>{flushParagraph();flushList();flushQuote()};
 for(const line of lines){
  const fenceMatch=/^\s*```\s*([A-Za-z0-9+#-]*)\s*$/.exec(line);
  if(fence!==null){
   if(fenceMatch){out.push('<pre data-code="'+(fence||'text')+'">'+esc(fenceLines.join('\n'))+'</pre>');fence=null;fenceLines=[]}
   else fenceLines.push(line);
   continue;
  }
  if(fenceMatch){flushAll();fence=fenceMatch[1]||'';continue}
  if(!line.trim()){flushAll();continue}
  const heading=/^(#{1,6})\s+(.*)$/.exec(line);
  if(heading){
   flushAll();
   const level=Math.min(heading[1].length,6),id=slug(headings.length+1);
   headings.push({level,title:heading[2].trim(),id});
   out.push('<'+headingLevels[level]+' data-heading="'+id+'">'+inline(heading[2].trim())+'</'+headingLevels[level]+'>');
   continue;
  }
  if(/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)){flushAll();out.push('<hr>');continue}
  const quoted=/^\s*>\s?(.*)$/.exec(line);
  if(quoted){flushParagraph();flushList();quote.push(quoted[1]);continue}
  const bullet=/^\s*[-*+]\s+(.*)$/.exec(line),ordered=/^\s*\d+[.)]\s+(.*)$/.exec(line);
  if(bullet||ordered){
   flushParagraph();flushQuote();
   const tag=bullet?'ul':'ol';
   if(!list||list.tag!==tag)flushList();
   if(!list)list={tag,items:[]};
   list.items.push((bullet??ordered)[1]);
   continue;
  }
  if(list){flushList()}
  if(quote.length){flushQuote()}
  paragraph.push(line);
 }
 if(fence!==null)out.push('<pre data-code="'+(fence||'text')+'">'+esc(fenceLines.join('\n'))+'</pre>');
 flushAll();
 return {html:out.join(''),headings};
}

/** 阅读器外壳：目录 + 可滚动正文 + 全屏开关（由调用方接线）。 */
export function readerHtml(text){
 const {html,headings}=renderMarkdown(text);
 const toc=headings.length>=2
  ?'<nav class="mdtoc" data-mdtoc="1" aria-label="目录"><b>目录</b>'+headings.map(item=>'<a href="#'+item.id+'" data-mdgoto="'+item.id+'" style="--md-depth:'+(item.level-1)+'">'+esc(item.title)+'</a>').join('')+'</nav>'
  :'';
 return `${toc}<div class="mdbody" data-mdbody="1" tabindex="0">${html||'<p>（没有可显示的内容）</p>'}</div>`;
}
