// JSON can encode one UTF-8 control byte as six ASCII bytes (\u00xx).
export const TEXT_FILE_MAX_BYTES=2*1024*1024;
// 会议录音远大于文本；转写读取单独设上限，超限如实拒绝而不是截断。
export const AUDIO_FILE_MAX_BYTES=25*1024*1024;
// 预览按浏览器原生渲染；字节只在授权目录内流式返回，插件不做解析或转码。
export const PREVIEW_FILE_MAX_BYTES=32*1024*1024;
// Office 转换需要先把源文件交给宿主的 officeToPdf 队列，单独给上限。
export const OFFICE_SOURCE_MAX_BYTES=32*1024*1024;
export const REQUEST_MAX_BYTES=6*TEXT_FILE_MAX_BYTES+64*1024;
