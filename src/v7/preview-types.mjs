// 与 src/file-preview-route.mjs 的 previewTypes / officeExtensions 保持一致（有测试核对两侧清单）。
export const previewTypes=Object.freeze({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',bmp:'image/bmp',pdf:'application/pdf'});
// 录音单独一组（2026-10-16）：走 Range 按窗口取字节，播放器才能拖动进度条，
// 也不用把 52MB 的会议录音整个读进内存。与 src/file-preview-route.mjs 的 audioTypes 保持一致。
export const audioTypes=Object.freeze({m4a:'audio/mp4',mp3:'audio/mpeg',wav:'audio/wav',aac:'audio/aac',ogg:'audio/ogg',flac:'audio/flac'});
export const audioExtensions=Object.freeze(Object.keys(audioTypes));
export const isAudio=path=>audioExtensions.includes(String(path).trim().toLowerCase().split('.').pop());
// Office 由宿主 officeToPdf 转成 PDF 后交给浏览器内置查看器；工作台内不做解析。
export const officeExtensions=Object.freeze(['doc','docx','xls','xlsx','ppt','pptx']);
export const isOffice=path=>officeExtensions.includes(String(path).trim().toLowerCase().split('.').pop());
export const isPreviewable=path=>Boolean(previewTypes[String(path).trim().toLowerCase().split('.').pop()])||isOffice(path)||isAudio(path);
