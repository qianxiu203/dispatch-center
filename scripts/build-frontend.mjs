// 前端打包脚本：用 esbuild 把 public/src/app.ts 打包为 public/dist/app.js
// 选 esbuild 的理由：零配置、快、单文件产物，Windows/Linux 均可用。
import * as esbuild from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const pub = join(root, "..", "public");
mkdirSync(join(pub, "dist"), { recursive: true });

await esbuild.build({
  entryPoints: [join(pub, "src", "app.ts")],
  bundle: true,
  outfile: join(pub, "dist", "app.js"),
  format: "iife",
  target: "es2020",
  minify: false,
  logLevel: "info",
});
console.log("前端打包完成: public/dist/app.js");
