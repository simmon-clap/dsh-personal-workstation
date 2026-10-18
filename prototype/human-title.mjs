/** 历史数据里存过「撤销批次 <uuid>」这类机器标题：显示时换成人话（不动数据）。
 *  数据是既成事实，改不了也不该改；用户看到的那一层必须是人话。 */
export function humanTitle(title){
 const text=String(title??'').trim();
 if(/^撤销批次\s+[0-9a-fA-F-]{8,}/.test(text))return '撤销上一次改动';
 if(/^批次\s+[0-9a-fA-F-]{8,}/.test(text))return '一次改动';
 return text||'未命名';
}
