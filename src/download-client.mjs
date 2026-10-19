export const downloadClient=`
function downloadText(file){const url=URL.createObjectURL(new Blob([file.content],{type:file.mime}));const link=document.createElement('a');link.href=url;link.download=file.filename;document.body.append(link);try{link.click()}finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)}}
`;
