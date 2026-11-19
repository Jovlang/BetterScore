import {build} from "esbuild";
import {copyFile, mkdir} from "node:fs/promises";

const outputDirectory = "../.obsidian/plugins/betterscore";

await mkdir(outputDirectory, {recursive: true});
await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian"],
  platform: "browser",
  format: "cjs",
  target: "es2020",
  outfile: `${outputDirectory}/main.js`,
  logLevel: "info"
});
await Promise.all([
  copyFile("manifest.json", `${outputDirectory}/manifest.json`),
  copyFile("styles.css", `${outputDirectory}/styles.css`)
]);
