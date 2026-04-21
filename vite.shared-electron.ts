import path from "node:path";
import { builtinModules } from "node:module";

export const electronAlias = {
  "@main": path.resolve(__dirname, "src/main"),
  "@preload": path.resolve(__dirname, "src/preload"),
  "@runtime": path.resolve(__dirname, "src/runtime"),
  "@shared": path.resolve(__dirname, "src/shared"),
  "@generated": path.resolve(__dirname, "src/generated")
};

export const electronExternal = ["electron", ...builtinModules, ...builtinModules.map((entry) => `node:${entry}`)];
