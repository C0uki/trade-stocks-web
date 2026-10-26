import { expect, test, type Page, type Response } from "@playwright/test";
import { login, uid } from "./helpers";

/** 架空データで、先物の新規売り→返済、追証→強制決済、信用買いを通す */

const DATE = /"(19|20)\d\d-\d\d-\d\d/;

type View = {
  margin: { call: boolean; forceClose: boolean; free: number; required: number };
  leveraged: { account: string; side: string }[];
  ledger: { kind: string; note: string | null }[];
};

const getView = async (page: Page, id: string): Promise<View> => (await page.request.get(`/api/scenarios/${id}`)).json();
const advance = (page: Page, id: string) => page.request.post(`/api/scenarios/${id}/advance`, { data: { steps: 1 } });

test("先物の新規売りから返済まで。ランク戦中に実日付・基準値は漏れない", async ({ page }) => {
  await login(page, uid("e2e-fut"));
  const leaks: string[] = [];
  page.on("response", async (res: Response) => {
    if (!res.url().includes("/api/scenarios")) return;
    const body = await res.text().catch(() => "");
    if (DATE.test(body) || body.includes("basePriceJpy") || body.includes("baseFx")) leaks.push(res.url());
  });
  await page.getByRole("button", { name: "ランク戦を始める（架空銘柄）" }).click();
  await expect(page).toHaveURL(/\/play\//);

  await page.getByRole("button", { name: "先物", exact: true }).click();
  const first = page.getByTestId("market-list").locator("button").first();
  const name = (await first.locator("span.font-medium").textContent())?.trim() ?? "";
  await first.click();
  await expect(page.getByTestId("instrument-name")).toHaveText(name);
  await page.getByRole("button", { name: "新規売り" }).click();
  await page.getByRole("button", { name: "¥10,000,000" }).click();
  await expect(page.getByTestId("margin-preview")).toContainText("必要証拠金 ¥1,000,000");
  await page.getByTestId("submit-order").click();
  await expect(page.getByText("注文を受け付けました")).toBeVisible();

  // 休場に当たったら約定するまで進める
  for (let i = 0; i < 5 && (await page.getByTestId("leveraged").count()) === 0; i++) {
    await page.getByTestId("next1").click();
    await page.getByRole("tab", { name: /保有/ }).click();
  }
  const row = page.getByTestId("leveraged").locator("tbody tr");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("先物売り");
  await expect(page.getByTestId("required-margin")).not.toHaveText("¥0");

  await page.getByRole("button", { name: "返済", exact: true }).click();
  await page.getByTestId("submit-order").click();
  await expect(page.getByText("注文を受け付けました")).toBeVisible();
  for (let i = 0; i < 5 && (await page.getByTestId("leveraged").count()) > 0; i++) {
    await page.getByTestId("next1").click();
    await page.getByRole("tab", { name: /保有/ }).click();
  }
  await expect(page.getByTestId("leveraged")).toHaveCount(0);
  await page.getByRole("tab", { name: "取引履歴" }).click();
  await expect(page.getByTestId("history")).toContainText("先物返済買い");
  expect(leaks, `実日付・基準値が漏れたレスポンス: ${leaks.join(", ")}`).toEqual([]);
});

test("証拠金いっぱいに建てると追証が出て、解消しなければ強制決済される", async ({ page }) => {
  await login(page, uid("e2e-call"));
  const { id } = await (await page.request.post("/api/scenarios", { data: { mode: "practice" } })).json();
  const market: { id: number; kind: string }[] = await (await page.request.get(`/api/scenarios/${id}/market`)).json();
  const future = market.find((m) => m.kind === "future")!;
  const openLong = (amount: number) =>
    page.request.post(`/api/scenarios/${id}/orders`, {
      data: { instrumentId: future.id, side: "buy", account: "future", action: "open", type: "market", amount },
    });
  // 証拠金率10%なので、1,000万円の現金で建てられる上限は約1億円
  expect((await openLong(100_000_000)).ok()).toBeTruthy();
  // 先物は現物としては注文できない
  const wrong = await page.request.post(`/api/scenarios/${id}/orders`, {
    data: { instrumentId: future.id, side: "buy", type: "market", amount: 1000 },
  });
  expect(wrong.status()).toBe(400);

  // 値上がりで余力が増えたら、また上限まで建て増す（どこかで下がった日に追証になる）
  let view = await getView(page, id);
  for (let i = 0; i < 200 && !(view.margin.call || view.margin.forceClose); i++) {
    if (view.margin.free > 10_000) await openLong(Math.floor(view.margin.free / 0.1));
    expect((await advance(page, id)).ok()).toBeTruthy();
    view = await getView(page, id);
  }
  expect(view.margin.call || view.margin.forceClose).toBe(true);
  await page.goto(`/play/${id}`);
  await expect(page.getByTestId("margin-call")).toBeVisible();
  // 追証中の新規建ては受け付けない
  expect((await openLong(1000)).status()).toBe(409);

  // 解消しなければ強制決済される。値上がりで自然に解消した日は、また上限まで建て増す
  // （休場日は強制決済が次の取引日に延びる）
  for (let i = 0; i < 100 && view.leveraged.length > 0; i++) {
    if (!view.margin.call && !view.margin.forceClose && view.margin.free > 10_000) {
      await openLong(Math.floor(view.margin.free / 0.1));
    }
    await advance(page, id);
    view = await getView(page, id);
  }
  expect(view.leveraged).toHaveLength(0);
  expect(view.ledger.some((l) => l.kind === "trade" && l.note === "forced")).toBe(true);
});

test("信用買いの注文と、反対向きの新規建ての拒否", async ({ page }) => {
  await login(page, uid("e2e-margin"));
  const { id } = await (await page.request.post("/api/scenarios", { data: { mode: "practice" } })).json();
  const market: { id: number; kind: string }[] = await (await page.request.get(`/api/scenarios/${id}/market`)).json();
  const stock = market.find((m) => m.kind === "stock")!;
  const place = (data: Record<string, unknown>) =>
    page.request.post(`/api/scenarios/${id}/orders`, { data: { instrumentId: stock.id, type: "market", ...data } });
  expect((await place({ side: "buy", account: "margin", action: "open", amount: 20_000_000 })).ok()).toBeTruthy();
  let view = await getView(page, id);
  for (let i = 0; i < 5 && view.leveraged.length === 0; i++) {
    await advance(page, id);
    view = await getView(page, id);
  }
  expect(view.leveraged[0]).toMatchObject({ account: "margin", side: "long" });
  // 2,000万円の建玉で、必要証拠金は30%＝600万円前後
  expect(view.margin.required).toBeGreaterThan(5_000_000);
  expect((await place({ side: "sell", account: "margin", action: "open", amount: 1_000_000 })).status()).toBe(400);
  expect((await place({ side: "sell", account: "margin", action: "close", fraction: 1 })).ok()).toBeTruthy();
});
