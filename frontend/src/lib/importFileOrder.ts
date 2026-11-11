const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

function chapterNumber(name: string): number | null {
  const match = name.normalize("NFKC").match(/第\s*([零〇一二三四五六七八九十百千万两\d]+)\s*[章节回话]/);
  if (!match) return null;
  const value = match[1];
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
  if ([...value].every((char) => char in digits)) return Number([...value].map((char) => digits[char]).join(""));
  let total = 0, section = 0, digit = 0;
  for (const char of value) {
    if (char in digits) digit = digits[char];
    else if (units[char] === 10000) { total += (section + digit) * 10000; section = 0; digit = 0; }
    else if (char in units) { section += (digit || 1) * units[char]; digit = 0; }
    else return null;
  }
  return total + section + digit;
}

/** 接收一批章节时先按章号排序；没有章号则按含数字的文件名排序。用户之后可手动调整。 */
export function compareImportFiles(a: File, b: File): number {
  const sortName = (file: File) => {
    const name = file.name.normalize("NFKC"), number = chapterNumber(name);
    return number === null ? name : name.replace(/第\s*[零〇一二三四五六七八九十百千万两\d]+\s*[章节回话]/, `第${number}章`);
  };
  return collator.compare(sortName(a), sortName(b)) || collator.compare(a.name, b.name);
}
