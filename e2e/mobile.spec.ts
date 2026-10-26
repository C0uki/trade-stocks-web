import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

test("スマホ幅でも横にはみ出さない", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("名前（英数字）").fill(`e2e-mobile-${Date.now()}`);
  await page.getByRole("button", { name: "ログイン" }).last().click();
  await expect(page).toHaveURL("/");
  await page.getByRole("button", { name: "ランク戦を始める（架空銘柄）" }).click();
  await expect(page.getByTestId("instrument-name")).toBeVisible();
  for (const path of [null, "/", "/rules", "/ranking", "/practice", "/terms", "/privacy"]) {
    if (path) await page.goto(path);
    expect(await page.evaluate(() => document.documentElement.scrollWidth), path ?? "/play").toBeLessThanOrEqual(390);
  }
});
