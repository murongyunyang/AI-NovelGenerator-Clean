// 检查组件里 t("key") 用到的翻译是否在 zh/en 两份文案里都存在；缺了界面会直接显示键名。
// 只查 useTranslations("命名空间") 只出现一次的文件，以及字面量键名。用法：node scripts/check-i18n-keys.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../src/", import.meta.url));
const messages = Object.fromEntries(["zh", "en"].map((lang) => [lang, JSON.parse(readFileSync(join(root, "i18n/messages", `${lang}.json`), "utf8"))]));
const lookup = (tree, path) => path.split(".").reduce((node, part) => (node && typeof node === "object" ? node[part] : undefined), tree);

const files = [];
const walk = (dir) => readdirSync(dir).forEach((name) => {
  const full = join(dir, name);
  if (statSync(full).isDirectory()) walk(full);
  else if (/\.tsx?$/.test(name)) files.push(full);
});
walk(root);

let missing = 0;
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const spaces = [...source.matchAll(/(?:const|let)\s+t\s*=\s*useTranslations\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]);
  // 同一文件用了多个命名空间时，子组件可能拿到别的 t，按字面无法判断。
  if (spaces.length !== 1 || (source.match(/useTranslations\(/g) ?? []).length > 2) continue;
  const keys = new Set([...source.matchAll(/(?<![\w.])t\(\s*"([A-Za-z0-9_.]+)"/g)].map((m) => m[1]));
  for (const key of keys) {
    for (const lang of ["zh", "en"]) {
      if (lookup(messages[lang], `${spaces[0]}.${key}`) === undefined) {
        missing += 1;
        console.log(`${lang} 缺少 ${spaces[0]}.${key}  (${file.slice(root.length)})`);
      }
    }
  }
}
console.log(missing ? `共缺 ${missing} 处` : "全部翻译键都存在");
process.exit(missing ? 1 : 0);
