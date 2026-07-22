import { expect, test } from "@playwright/test";
import { launchCompiledWorkbench } from "./helpers/electron-app";

test("launcher fills the window and keeps setup detail progressive", async () => {
  const workbench = await launchCompiledWorkbench();
  const pageErrors: string[] = [];

  try {
    const page = await workbench.app.firstWindow();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.waitForLoadState("domcontentloaded");
    await workbench.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1_480, 940);
    });

    await expect(page.getByRole("heading", { name: "Begin with the project you want to build." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open a project" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Create GitHub repository" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Keep folder local" })).toHaveAttribute("aria-pressed", "false");

    const layout = await page.evaluate(() => {
      const bounds = (selector: string) => {
        const rect = document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
        return rect ? { width: rect.width, height: rect.height, left: rect.left, top: rect.top } : undefined;
      };
      const clipPath = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        return element ? getComputedStyle(element).clipPath : undefined;
      };
      return {
        viewport: { width: innerWidth, height: innerHeight },
        root: bounds("#root"),
        shell: bounds(".shell--launcher"),
        content: bounds(".launcher-shell"),
        hero: bounds(".launcher-hero"),
        horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
        clips: {
          content: clipPath(".launcher-shell"),
          hero: clipPath(".launcher-hero"),
          recents: clipPath(".launcher-recents")
        }
      };
    });

    expect(layout.root?.width).toBeGreaterThanOrEqual(layout.viewport.width * 0.99);
    expect(layout.root?.height).toBeGreaterThanOrEqual(layout.viewport.height * 0.99);
    expect(layout.shell?.width).toBeGreaterThanOrEqual(layout.viewport.width * 0.99);
    expect(layout.shell?.height).toBeGreaterThanOrEqual(layout.viewport.height * 0.99);
    expect(layout.content?.width).toBeGreaterThanOrEqual(layout.viewport.width * 0.7);
    expect(layout.hero?.width).toBeGreaterThanOrEqual(layout.viewport.width * 0.7);
    expect(layout.horizontalOverflow).toBeLessThanOrEqual(1);
    expect(layout.clips).toEqual({ content: "none", hero: "none", recents: "none" });

    const setupDetails = page.locator(".launcher-readiness__details");
    await expect(setupDetails).not.toHaveAttribute("open", "");
    await setupDetails.locator("summary").click();
    await expect(setupDetails).toHaveAttribute("open", "");
    await expect(page.getByRole("button", { name: "Run setup checks" })).toBeVisible();
    await expect(setupDetails.getByRole("button", { name: "Open settings" })).toBeVisible();
    await setupDetails.locator("summary").click();

    if (process.env.AWB_CAPTURE_LAUNCHER === "1") {
      await page.screenshot({ path: "/tmp/agentic-workbench-launcher.png", fullPage: true });
    }

    await workbench.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(760, 520);
    });
    await expect.poll(async () => await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 760, height: 520 });
    const narrowLayout = await page.evaluate(() => ({
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
      shellWidth: document.querySelector<HTMLElement>(".shell--launcher")?.getBoundingClientRect().width ?? 0,
      contentWidth: document.querySelector<HTMLElement>(".launcher-shell")?.getBoundingClientRect().width ?? 0
    }));
    expect(narrowLayout.horizontalOverflow).toBeLessThanOrEqual(1);
    expect(narrowLayout.shellWidth).toBeGreaterThanOrEqual(759);
    expect(narrowLayout.contentWidth).toBeGreaterThanOrEqual(760 * 0.9);
    expect(pageErrors).toEqual([]);
  } finally {
    await workbench.close();
  }
});
