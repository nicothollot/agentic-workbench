import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const png2icons = require("png2icons");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const sourceIconPath = path.join(rootDir, "assets", "branding", "interface_icon.png");
const runtimeIconPath = path.join(rootDir, "assets", "branding", "app.ico");
const generatedIconsDir = path.join(rootDir, "build-resources", "generated");
const buildPngPath = path.join(generatedIconsDir, "icon.png");
const buildIcoPath = path.join(generatedIconsDir, "icon.ico");
const buildIcnsPath = path.join(generatedIconsDir, "icon.icns");

const sourcePng = await readFile(sourceIconPath);
const icoBuffer = png2icons.createICO(sourcePng, png2icons.BICUBIC2, 0, false, true);
const icnsBuffer = png2icons.createICNS(sourcePng, png2icons.BICUBIC2, 0);

if (!icoBuffer || !icnsBuffer) {
  throw new Error(`Failed to generate icon assets from ${sourceIconPath}`);
}

await mkdir(generatedIconsDir, { recursive: true });
await Promise.all([
  writeFile(runtimeIconPath, icoBuffer),
  writeFile(buildPngPath, sourcePng),
  writeFile(buildIcoPath, icoBuffer),
  writeFile(buildIcnsPath, icnsBuffer)
]);

console.log(`Generated runtime and build icon assets from ${path.relative(rootDir, sourceIconPath)}`);
