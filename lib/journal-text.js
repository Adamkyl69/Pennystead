// ASCII folding for generated journal files (see journal.js for why).
const FOLD = { 'ı': 'i', 'İ': 'I', 'ß': 'ss', 'ø': 'o', 'Ø': 'O', 'æ': 'ae', 'Æ': 'AE', 'đ': 'd', 'Đ': 'D', 'ł': 'l', 'Ł': 'L', 'œ': 'oe', 'Œ': 'OE', 'þ': 'th', 'Þ': 'Th', 'ð': 'd', 'Ð': 'D' };
const ascii = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x00-\x7f]/g, (c) => FOLD[c] ?? '?');
module.exports = { ascii, FOLD };
