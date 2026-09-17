// Syntax-check every server and browser script: npm run check
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

const js = (dir) => readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => `${dir}/${f}`);
const files = [...js("src"), ...js("src/lib"), "public/app.js"];

for (const file of files) execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
console.log(`ok: ${files.length} files`);
