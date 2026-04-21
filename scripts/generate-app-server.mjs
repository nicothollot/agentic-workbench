import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, "../src/generated/app-server");

await mkdir(outDir, { recursive: true });

await new Promise((resolve, reject) => {
  const child = spawn("codex", ["app-server", "generate-ts", "--experimental", "--out", outDir], {
    stdio: "inherit"
  });

  child.on("exit", (code) => {
    if (code === 0) {
      resolve(undefined);
      return;
    }
    reject(new Error(`codex app-server generate-ts exited with code ${code ?? -1}`));
  });
  child.on("error", reject);
});
