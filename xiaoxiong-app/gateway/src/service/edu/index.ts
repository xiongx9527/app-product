/**
 * 教育/诗词数据源域：显式多源架构。
 * 百度汉语只是其中一个源（默认/唯一）。每个源实现放在自己的子目录（如 baidu/），
 * 工具层只依赖这里导出的 queryPoem / 类型，不绑定具体站点。新增源两步：
 *   ① 新建 edu/<源名>/ 目录并实现 queryPoem；② 在本文件汇聚/切换。
 */
export {
  queryPoem,
  extractPoemSid,
  parsePoemDetail,
  type EduFetcher,
  type PoemEntry,
} from './baidu/poemSource'
