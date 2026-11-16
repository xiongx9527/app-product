/**
 * lunar-javascript 的最小类型声明：只声明本项目用到的农历接口。
 * 该库无官方 @types 包（npm 404），按实际返回结构收窄，避免隐式 any（tsconfig strict）。
 */
declare module 'lunar-javascript' {
  export interface Lunar {
    /** 农历月序号：负数表示闰月（如 -10 为闰十月） */
    getMonth(): number
    /** 农历月中文（不带「闰」字，如「十」「冬」「腊」） */
    getMonthInChinese(): string
    /** 农历日中文（如「初一」「廿七」「三十」） */
    getDayInChinese(): number | string
    /** 今日黄历「宜」事项列表（库内置权威历法数据） */
    getDayYi(): string[]
    /** 今日黄历「忌」事项列表 */
    getDayJi(): string[]
  }
  export interface Solar {
    getLunar(): Lunar
  }
  export const Solar: {
    /** 由公历日期构造阳历对象 */
    fromDate(date: Date): Solar
    /** 由公历年月日数字构造阳历对象（用于按会话时区格式化出的 Y/M/D，避免依赖进程本地时区） */
    fromYmd(y: number, m: number, d: number): Solar
  }
}
