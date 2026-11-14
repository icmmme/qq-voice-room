const SENSITIVE_LABEL = /密码|口令|验证码|身份证|银行卡|信用卡|住址|门牌|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|secret|private[ _-]?key|密钥|令牌|手机号|电话号码|邮箱|电子邮件|生日|出生日期|收入|工资|病史|诊断|处方/i;
// Shape-based detection for unlabelled secrets that the label list misses.
const PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const ID_CARD = /(?<!\d)\d{17}[\dXx](?!\d)/;
const BANK_CARD = /(?<!\d)\d{16,19}(?!\d)/;
const STREET_ADDRESS = /[\u4e00-\u9fff]{1,12}(?:路|街|道|巷|胡同|里弄|弄|小区|花园|公寓|大厦|大楼)[\d０-９一二三四五六七八九十百千]{1,6}(?:号|弄|栋|幢|单元|室|楼|层)/;

export function containsSensitive(text: string): boolean {
  return SENSITIVE_LABEL.test(text) || PHONE.test(text) || EMAIL.test(text) ||
    ID_CARD.test(text) || BANK_CARD.test(text) || STREET_ADDRESS.test(text);
}
