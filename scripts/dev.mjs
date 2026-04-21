import { spawn } from "node:child_process";
import { once } from "node:events";

const renderer = spawn("npx", ["vite"], {
  stdio: "inherit",
  shell: process.platform === "win32"
});

const electron = spawn("npx", ["tsc", "-p", "tsconfig.electron.json", "--watch", "--preserveWatchOutput"], {
  stdio: "inherit",
  shell: process.platform === "win32"
});

const launcher = spawn("npx", ["electron", "."], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: "http://127.0.0.1:5173"
  }
});

const closeAll = () => {
  renderer.kill("SIGTERM");
  electron.kill("SIGTERM");
  launcher.kill("SIGTERM");
};

process.on("SIGINT", closeAll);
process.on("SIGTERM", closeAll);

await Promise.race([once(renderer, "exit"), once(electron, "exit"), once(launcher, "exit")]);
closeAll();
