import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { launchCompiledWorkbench } from "./helpers/electron-app";

const openFixtureProject = async (
  page: Page,
  projectDir: string
): Promise<void> => {
  await page.evaluate(async (inputPath) => {
    const workbench = (window as unknown as {
      workbench: {
        loadProject(path: string, intent: "open", creationMode: "use_folder_as_is"): Promise<unknown>;
        selectInterface(source: "fresh", path?: string, freshBehavior?: "replace"): Promise<unknown>;
      };
    }).workbench;
    await workbench.loadProject(inputPath, "open", "use_folder_as_is");
    await workbench.selectInterface("fresh", undefined, "replace");
  }, projectDir);
  const setupSettingsSave = page.getByRole("button", { name: "Save Settings" });
  if (await setupSettingsSave.waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false)) {
    await page.locator(".settings-appearance__controls").getByLabel("Motion").selectOption("reduced");
    await expect(setupSettingsSave).toBeEnabled();
    await setupSettingsSave.click();
    await setupSettingsSave.waitFor({ state: "hidden" });
  }
  await expect(page.getByRole("navigation", { name: "Workspace navigation" })).toBeVisible();
};

test("compiled Electron app launches in an isolated, sandboxed profile", async () => {
  const workbench = await launchCompiledWorkbench();
  const pageErrors: string[] = [];

  try {
    const page = await workbench.app.firstWindow();
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator("#root")).toBeVisible();

    const surface = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>("#root");
      const bounds = root?.getBoundingClientRect();
      return {
        url: window.location.href,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        root: bounds ? { width: bounds.width, height: bounds.height } : undefined,
        hasWorkbenchBridge: typeof (window as Window & { workbench?: unknown }).workbench === "object",
        hasNodeProcess: typeof (globalThis as typeof globalThis & { process?: unknown }).process !== "undefined",
        hasNodeRequire: typeof (globalThis as typeof globalThis & { require?: unknown }).require !== "undefined"
      };
    });

    expect(surface.url).toMatch(/^file:/);
    expect(surface.hasWorkbenchBridge).toBe(true);
    expect(surface.hasNodeProcess).toBe(false);
    expect(surface.hasNodeRequire).toBe(false);
    expect(surface.viewport.width).toBeGreaterThanOrEqual(1_024);
    expect(surface.viewport.height).toBeGreaterThanOrEqual(640);
    expect(surface.root).toBeDefined();
    expect(surface.root!.width).toBeGreaterThanOrEqual(surface.viewport.width * 0.99);
    expect(surface.root!.height).toBeGreaterThanOrEqual(surface.viewport.height * 0.99);

    const runtime = await workbench.app.evaluate(({ app, BrowserWindow }) => {
      return {
        userDataDir: app.getPath("userData"),
        windowCount: BrowserWindow.getAllWindows().length
      };
    });

    expect(path.resolve(runtime.userDataDir)).toBe(path.resolve(workbench.userDataDir));
    expect(runtime.windowCount).toBe(1);
    expect(pageErrors).toEqual([]);
  } finally {
    await workbench.close();
  }
});

test("renderer fills the content viewport at simulated 200% Windows display scaling", async () => {
  const workbench = await launchCompiledWorkbench({}, ["--force-device-scale-factor=2"]);

  try {
    const page = await workbench.app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await workbench.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1_200, 760);
    });
    await expect.poll(async () => await page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
      .toEqual({ width: 1_200, height: 760 });

    const surface = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>("#root")?.getBoundingClientRect();
      return {
        viewport: { width: innerWidth, height: innerHeight },
        root: root ? { width: root.width, height: root.height } : undefined,
        devicePixelRatio: window.devicePixelRatio
      };
    });
    const zoomFactor = await workbench.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor()
    );

    expect(surface.devicePixelRatio).toBeGreaterThanOrEqual(1.75);
    expect(zoomFactor).toBe(1);
    expect(surface.root?.width).toBeGreaterThanOrEqual(surface.viewport.width * 0.99);
    expect(surface.root?.height).toBeGreaterThanOrEqual(surface.viewport.height * 0.99);
  } finally {
    await workbench.close();
  }
});

test("workspace routes, settings previews, drawer, and Windows-scale layouts remain synchronized", async () => {
  const workbench = await launchCompiledWorkbench();
  const pageErrors: string[] = [];

  try {
    const page = await workbench.app.firstWindow();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.waitForLoadState("domcontentloaded");
    await workbench.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1_480, 940);
    });
    await openFixtureProject(page, workbench.projectDir);

    if (process.env.AWB_CAPTURE_WORKSPACE === "1") {
      await page.screenshot({ path: "/tmp/agentic-workbench-workspace.png", fullPage: false });
    }

    const center = page.locator(".workbench-center");
    const centerWidthBeforeDrawer = (await center.boundingBox())?.width;
    await page.getByRole("button", { name: "Open attention queue" }).click();
    await expect(page.getByRole("dialog", { name: "Review and control" })).toBeVisible();
    expect((await center.boundingBox())?.width).toBe(centerWidthBeforeDrawer);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Review and control" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Open attention queue" })).toBeFocused();

    await page.getByRole("button", { name: /^Preview/ }).click();
    await expect(page.locator(".top-app-bar__app")).toHaveText("Preview");
    await expect(page.getByRole("heading", { name: "Preview and review" })).toBeVisible();
    await page.getByRole("button", { name: /^Activity/ }).click();
    await expect(page.locator(".top-app-bar__app")).toHaveText("Activity");
    await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
    await page.getByRole("button", { name: /^Mission/ }).click();
    await expect(page.locator(".top-app-bar__app")).toHaveText("Mission");

    await page.getByRole("button", { name: "Advanced" }).click();
    await page.getByRole("button", { name: /^Settings/ }).click();
    await expect(page.locator(".top-app-bar__app")).toHaveText("Settings");
    const shell = page.locator(".shell--workspace");
    await page.getByRole("radio", { name: /CATC Light/ }).click();
    await expect(shell).toHaveAttribute("data-theme", "catc-light");
    await page.locator(".settings-appearance__controls").getByLabel("Density").selectOption("compact");
    await expect(shell).toHaveAttribute("data-density", "compact");
    const settingsHorizontalOverflow = await page.evaluate(() => {
      const measure = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        return element ? element.scrollWidth - element.clientWidth : 0;
      };
      const center = document.querySelector<HTMLElement>(".workbench-center__scroll");
      return {
        center: measure(".workbench-center__scroll"),
        stack: measure(".settings-page-stack"),
        panel: measure(".settings-panel--page"),
        centerOverflowX: center ? getComputedStyle(center).overflowX : undefined
      };
    });
    // Chromium's stable vertical scrollbar gutter is included in scrollWidth;
    // the content itself must fit and horizontal scrolling must stay disabled.
    expect(settingsHorizontalOverflow.center).toBeLessThanOrEqual(16);
    expect(settingsHorizontalOverflow.stack).toBe(0);
    expect(settingsHorizontalOverflow.panel).toBe(0);
    expect(settingsHorizontalOverflow.centerOverflowX).toBe("hidden");
    if (process.env.AWB_CAPTURE_SETTINGS === "1") {
      await page.screenshot({ path: "/tmp/agentic-workbench-settings-light.png", fullPage: false });
    }
    await page.getByRole("button", { name: "Save Settings" }).click();
    await expect(page.getByText("Preferences match the saved configuration.")).toBeVisible();

    await workbench.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(911, 640);
    });
    await expect.poll(async () => await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 911, height: 640 });
    const windowsScaleLayout = await page.evaluate(() => ({
      topBarHeight: document.querySelector<HTMLElement>(".top-app-bar")?.getBoundingClientRect().height ?? 0,
      centerScrollHeight: document.querySelector<HTMLElement>(".workbench-center__scroll")?.getBoundingClientRect().height ?? 0,
      statusStripHeight: document.querySelector<HTMLElement>(".project-status-strip")?.getBoundingClientRect().height ?? 0
    }));
    expect(windowsScaleLayout.topBarHeight).toBeLessThanOrEqual(72);
    expect(windowsScaleLayout.centerScrollHeight).toBeGreaterThanOrEqual(640 * 0.78);
    expect(windowsScaleLayout.statusStripHeight).toBeLessThanOrEqual(42);

    await workbench.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(760, 520);
    });
    await expect.poll(async () => await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 760, height: 520 });
    const layout = await page.evaluate(() => {
      const root = document.getElementById("root")?.getBoundingClientRect();
      const shellBounds = document.querySelector<HTMLElement>(".shell")?.getBoundingClientRect();
      const topBar = document.querySelector<HTMLElement>(".top-app-bar")?.getBoundingClientRect();
      const centerScroll = document.querySelector<HTMLElement>(".workbench-center__scroll")?.getBoundingClientRect();
      const statusStrip = document.querySelector<HTMLElement>(".project-status-strip")?.getBoundingClientRect();
      const settingsContent = document.querySelector<HTMLElement>(".settings-page-stack")?.getBoundingClientRect();
      const visibleHeight = (bounds?: DOMRect) => bounds
        ? Math.max(0, Math.min(innerHeight, bounds.bottom) - Math.max(0, bounds.top))
        : 0;
      const unnamedButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .filter((button) => button.offsetParent !== null)
        .filter((button) => !(button.textContent?.trim() || button.getAttribute("aria-label") || button.getAttribute("title")))
        .length;
      const ids = Array.from(document.querySelectorAll<HTMLElement>("[id]")).map((element) => element.id);
      return {
        viewport: { width: innerWidth, height: innerHeight },
        root: root ? { width: root.width, height: root.height } : undefined,
        shell: shellBounds ? { width: shellBounds.width, height: shellBounds.height } : undefined,
        topBarHeight: topBar?.height ?? 0,
        centerScrollHeight: centerScroll?.height ?? 0,
        statusStripHeight: statusStrip?.height ?? 0,
        visibleSettingsHeight: visibleHeight(settingsContent),
        horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
        unnamedButtons,
        duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index)
      };
    });
    expect(layout.root?.width).toBeGreaterThanOrEqual(layout.viewport.width * 0.99);
    expect(layout.root?.height).toBeGreaterThanOrEqual(layout.viewport.height * 0.99);
    expect(layout.shell?.width).toBeGreaterThanOrEqual(layout.viewport.width * 0.99);
    expect(layout.shell?.height).toBeGreaterThanOrEqual(layout.viewport.height * 0.99);
    expect(layout.topBarHeight).toBeLessThanOrEqual(72);
    expect(layout.centerScrollHeight).toBeGreaterThanOrEqual(layout.viewport.height * 0.78);
    expect(layout.statusStripHeight).toBeLessThanOrEqual(42);
    expect(layout.visibleSettingsHeight).toBeGreaterThanOrEqual(layout.viewport.height * 0.6);
    expect(layout.horizontalOverflow).toBeLessThanOrEqual(1);
    expect(layout.unnamedButtons).toBe(0);
    expect(layout.duplicateIds).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally {
    await workbench.close();
  }
});

test("opening settings preserves a saved non-default appearance without a transient theme flash", async () => {
  const workbench = await launchCompiledWorkbench({
    appearanceTheme: "space",
    appearanceDensity: "compact"
  });

  try {
    const page = await workbench.app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await openFixtureProject(page, workbench.projectDir);
    const shell = page.locator(".shell--workspace");
    await expect(shell).toHaveAttribute("data-theme", "space");
    await expect(shell).toHaveAttribute("data-density", "compact");
    await page.evaluate(() => {
      const target = document.querySelector<HTMLElement>(".shell--workspace");
      const changes: string[] = [];
      (window as Window & { __appearanceChanges?: string[] }).__appearanceChanges = changes;
      if (target) {
        new MutationObserver(() => changes.push(`${target.dataset.theme}:${target.dataset.density}`))
          .observe(target, { attributes: true, attributeFilter: ["data-theme", "data-density"] });
      }
    });

    await page.getByRole("button", { name: "Advanced" }).click();
    await page.getByRole("button", { name: /^Settings/ }).click();
    await expect(page.locator(".top-app-bar__app")).toHaveText("Settings");
    await expect(shell).toHaveAttribute("data-theme", "space");
    await expect(shell).toHaveAttribute("data-density", "compact");
    await expect.poll(async () => await page.evaluate(() =>
      (window as Window & { __appearanceChanges?: string[] }).__appearanceChanges ?? []
    )).toEqual([]);
  } finally {
    await workbench.close();
  }
});
