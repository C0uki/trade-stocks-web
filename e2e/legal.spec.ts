import { expect, test } from "@playwright/test";

/** Google のログイン設定に載せる URL なので、ログインしていなくても開けること */
test("利用規約とプライバシーポリシーはログインなしで開け、ログイン画面とフッターからたどれる", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("main").getByRole("link", { name: "利用規約" }).click();
  await expect(page).toHaveURL("/terms");
  await expect(page.getByRole("heading", { level: 1, name: "利用規約" })).toBeVisible();

  await page.getByRole("contentinfo").getByRole("link", { name: "プライバシーポリシー" }).click();
  await expect(page).toHaveURL("/privacy");
  await expect(page.getByRole("heading", { level: 1, name: "プライバシーポリシー" })).toBeVisible();
  await expect(page.getByRole("link", { name: /github\.com\/.+\/issues/ })).toBeVisible();
});
