/** 浏览器下载助手：只产生副本，不改动源文件或数据库。 */
export function downloadFile(document,{filename,mime='application/octet-stream',content}){
 const url=URL.createObjectURL(new Blob([content],{type:mime}));
 const link=document.createElement('a');link.href=url;link.download=filename;document.body.append(link);
 try{link.click()}finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)}
}
export function downloadText(document,filename,content){downloadFile(document,{filename,mime:'text/plain;charset=utf-8',content})}
