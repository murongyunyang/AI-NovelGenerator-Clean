// 把网页里的启动动画（BootScenes 的十一幕、各风格的配色与样式、编排时长）导出给桌面客户端的启动页，两边用同一份，不另画一套。
// 用法：node scripts/build-splash.mjs <输出文件>（client/build.py 打包时调用；输出 client/novel_client/splash_assets.json）。
// 只依赖前端自己的 typescript、react、react-dom；转译后的模块放在 node_modules/.cache 下，模块解析和前端一致。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(FRONTEND, "package.json"));
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const CACHE = join(FRONTEND, "node_modules", ".cache", "build-splash");
mkdirSync(CACHE, { recursive: true });

/** 转译一个独立的 ts/tsx 文件（不能有项目内的 import），返回可以 import 的模块。 */
async function load(relative, name) {
  const source = readFileSync(join(FRONTEND, relative), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: relative,
  });
  const file = join(CACHE, `${name}.mjs`);
  writeFileSync(file, outputText);
  return import(pathToFileURL(file).href);
}

const scenes = await load("src/components/layout/BootScenes.tsx", "scenes");
const themes = await load("src/lib/themes.ts", "themes");
const timing = await load("src/components/layout/bootTiming.ts", "timing");

// 样式按 styles/looks/index.ts 的顺序：部件机制、各风格装饰变量、开机动画。
const order = [...readFileSync(join(FRONTEND, "src/styles/looks/index.ts"), "utf8").matchAll(/import "\.\/([\w-]+\.css)";/g)].map((m) => m[1]);
const css = order.map((name) => `/* ${name} */\n` + readFileSync(join(FRONTEND, "src/styles/looks", name), "utf8")).join("\n");

const output = resolve(process.argv[2] ?? join(FRONTEND, "..", "client", "novel_client", "splash_assets.json"));
const render = (lang) => renderToStaticMarkup(React.createElement(scenes.default, { lang }));
const data = {
  note: "由 frontend/scripts/build-splash.mjs 生成，勿手改；改动请改 BootScenes.tsx、styles/looks/*.css、bootTiming.ts 后重新生成。",
  looks: themes.THEME_PRESETS.map((preset) => preset.id),
  timing: timing.BOOT_TIMING,
  palette: themes.presetPaletteCss(),
  css,
  scenes: { zh: render("zh"), en: render("en") },
};
writeFileSync(output, JSON.stringify(data, null, 1) + "\n");
console.log(`启动页素材：${output}（${Math.round(JSON.stringify(data).length / 1024)} KB）`);
