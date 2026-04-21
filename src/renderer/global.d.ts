import type { WorkbenchApi } from "@preload/index";

declare module "*.png" {
  const src: string;
  export default src;
}

declare global {
  interface Window {
    workbench: WorkbenchApi;
  }
}

export {};
