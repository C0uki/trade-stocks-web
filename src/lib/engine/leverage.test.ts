import { describe, expect, it } from "vitest";
import type { AlignedBar } from "./calendar";
import type { CostRates } from "./costs";
import {
  advanceDay,
  initialState,
  liquidationValue,
  positionKey,
  type DayMarket,
  type EngineContext,
  type PortfolioState,
} from "./engine";
import type { Order } from "./orders";

const RATE = 0.20315;
const FREE: CostRates = { commission: 0, spread: 0, fxFee: 0 };
/** 先物の証拠金率 10%、信用 30%、金利なし（金利のテストだけ carry を付ける） */
const ctx = (over: Partial<EngineContext> = {}): EngineContext => ({
  rates: () => FREE,
  taxRate: RATE,
  marginRate: (_id, account) => (account === "future" ? 0.1 : 0.3),
  ...over,
});

const b = (open: number, close = open, high = Math.max(open, close), low = Math.min(open, close)): AlignedBar => ({
  open,
  high,
  low,
  close,
  volume: 1,
  tradable: true,
});
const day = (entries: [number, AlignedBar, { dividend?: number; fx?: number }?][]): DayMarket =>
  new Map(entries.map(([id, bar, o]) => [id, { bar, dividend: o?.dividend ?? 0, fx: o?.fx ?? 1 }]));

let seq = 0;
const order = (o: Partial<Order> & Pick<Order, "side">): Order => ({
  id: `o${++seq}`,
  instrumentId: 1,
  type: "market",
  limitPrice: null,
  amount: null,
  fraction: null,
  placedDay: 0,
  ...o,
});
const open = (side: "buy" | "sell", amount: number, account: "margin" | "future" = "future", instrumentId = 1) =>
  order({ side, amount, account, action: "open", instrumentId });
const close = (side: "buy" | "sell", fraction: number, account: "margin" | "future" = "future", instrumentId = 1) =>
  order({ side, fraction, account, action: "close", instrumentId });

const FUT = positionKey("future", 1);

describe("先物", () => {
  it("新規売り→値下がりで利益。損益は毎日の終値で現金に入り、返済で税を精算する", () => {
    let s: PortfolioState = { ...initialState(1_000_000), orders: [open("sell", 5_000_000)] };
    s = advanceDay(s, day([[1, b(100, 98)]]), ctx()).state;
    // 5万口の売り建て。100→98 で +10万円が値洗いで現金に入る
    expect(s.leveraged[FUT]).toMatchObject({ side: "short", qty: 50_000, mark: 98 });
    expect(s.cash).toBeCloseTo(1_100_000);
    s = { ...s, orders: [close("buy", 1)] };
    const { state, events } = advanceDay(s, day([[1, b(95, 99)]]), ctx());
    // 始値95で買い戻し：合計 +25万円。先物の区分で課税
    expect(state.leveraged[FUT]).toBeUndefined();
    expect(events.find((e) => e.kind === "trade")).toMatchObject({ action: "close", side: "buy", realizedPnl: 250_000 });
    expect(state.futuresTax.paid).toBeCloseTo(250_000 * RATE);
    expect(state.tax.paid).toBe(0);
    expect(state.cash).toBeCloseTo(1_250_000 - 250_000 * RATE);
  });

  it("株の利益と先物の損失は通算しない", () => {
    let s: PortfolioState = {
      ...initialState(1_000_000),
      positions: { 2: { qty: 100, costBasis: 10_000 } },
      orders: [open("buy", 1_000_000), order({ side: "sell", instrumentId: 2, fraction: 1 })],
    };
    // 株は +1万円、先物は 100→90 で -10万円
    s = advanceDay(s, day([[1, b(100, 90)], [2, b(200)]]), ctx()).state;
    s = { ...s, orders: [close("sell", 1)] };
    s = advanceDay(s, day([[1, b(90)], [2, b(200)]]), ctx()).state;
    expect(s.tax.paid).toBeCloseTo(10_000 * RATE);
    expect(s.futuresTax.paid).toBe(0);
    expect(s.futuresTax.realized).toBeCloseTo(-100_000);
  });

  it("外貨建て先物の損益は、その日の為替で円に換算する", () => {
    let s: PortfolioState = { ...initialState(1_000_000), orders: [open("buy", 1_000_000)] };
    s = advanceDay(s, day([[1, b(100), { fx: 1 }]]), ctx()).state;
    // 価格は動かず円安（fx 1→1.1）：損益は 0
    s = advanceDay(s, day([[1, b(100), { fx: 1.1 }]]), ctx()).state;
    expect(s.cash).toBeCloseTo(1_000_000);
    // 価格が 10% 上がった日の損益は、その日の為替で換算（1万口 × 10 × 1.1）
    s = advanceDay(s, day([[1, b(100, 110), { fx: 1.1 }]]), ctx()).state;
    expect(s.cash).toBeCloseTo(1_110_000);
  });

  it("反対向きの建玉があれば新規建ては取り消す（両建てなし）", () => {
    let s: PortfolioState = { ...initialState(1_000_000), orders: [open("buy", 1_000_000)] };
    s = advanceDay(s, day([[1, b(100)]]), ctx()).state;
    s = { ...s, orders: [open("sell", 1_000_000)] };
    const { events } = advanceDay(s, day([[1, b(100)]]), ctx());
    expect(events).toContainEqual(expect.objectContaining({ kind: "cancel", reason: "opposite_position" }));
  });

  it("新規建ては「現金 ≧ 必要証拠金」の範囲までに抑える", () => {
    const s0 = { ...initialState(100_000), orders: [open("buy", 5_000_000)] };
    const { state } = advanceDay(s0, day([[1, b(100)]]), ctx());
    // 証拠金率10%なので、10万円で建てられるのは100万円まで
    expect(state.leveraged[FUT].qty).toBeCloseTo(10_000);
  });

  it("証拠金に使っている現金では現物を買えない", () => {
    let s: PortfolioState = { ...initialState(1_000_000), orders: [open("buy", 5_000_000)] };
    s = advanceDay(s, day([[1, b(100)]]), ctx()).state;
    s = { ...s, orders: [order({ side: "buy", instrumentId: 2, amount: 1_000_000 })] };
    const { state } = advanceDay(s, day([[1, b(100)], [2, b(100)]]), ctx());
    expect(state.positions[2].costBasis).toBeCloseTo(500_000);
  });
});

describe("追証と強制決済", () => {
  /** 100万円で 1,000万円の先物を買う（必要証拠金 100万円、維持率100%） */
  const full = () => advanceDay({ ...initialState(1_000_000), orders: [open("buy", 10_000_000)] }, day([[1, b(100)]]), ctx()).state;

  it("必要証拠金を割ったら追証。翌日の終値で解消していれば強制決済しない", () => {
    let res = advanceDay(full(), day([[1, b(100, 99)]]), ctx()); // -10万円
    expect(res.state.marginCall).toBe(true);
    expect(res.events).toContainEqual(expect.objectContaining({ kind: "margin_call", level: "call" }));
    // 追証中の新規建ては取り消し、建玉を半分返済して解消
    const s = { ...res.state, orders: [open("buy", 1_000_000), close("sell", 0.5)] };
    res = advanceDay(s, day([[1, b(99)]]), ctx());
    expect(res.events).toContainEqual(expect.objectContaining({ kind: "cancel", reason: "margin_call" }));
    expect(res.state.marginCall).toBe(false);
    expect(res.state.forceClose).toBe(false);
  });

  it("翌日の終値でも足りなければ、その翌日の始値で強制決済する", () => {
    let s = advanceDay(full(), day([[1, b(100, 99)]]), ctx()).state;
    s = advanceDay(s, day([[1, b(99)]]), ctx()).state;
    expect(s.forceClose).toBe(true);
    const { state, events } = advanceDay(s, day([[1, b(98)]]), ctx());
    expect(state.leveraged[FUT]).toBeUndefined();
    expect(events.find((e) => e.kind === "trade")).toMatchObject({ orderId: "forced", price: 98 });
    expect(state.forceClose).toBe(false);
  });

  it("必要証拠金の30%を割るほどの損なら、猶予なしで翌日に強制決済する", () => {
    const res = advanceDay(full(), day([[1, b(100, 92)]]), ctx()); // -80万円 → 現金20万円 < 必要証拠金の30%
    expect(res.events).toContainEqual(expect.objectContaining({ kind: "margin_call", level: "emergency" }));
    expect(res.state.forceClose).toBe(true);
  });

  it("強制決済で現金がマイナスになったら、現物を売って埋める", () => {
    let s: PortfolioState = {
      ...full(),
      positions: { 2: { qty: 10_000, costBasis: 1_000_000 } },
    };
    s = advanceDay(s, day([[1, b(100, 85)], [2, b(100)]]), ctx()).state; // 現金 -50万円
    expect(s.forceClose).toBe(true);
    const { state, events } = advanceDay(s, day([[1, b(85)], [2, b(100)]]), ctx());
    expect(state.cash).toBeCloseTo(0);
    expect(events.find((e) => e.kind === "trade" && e.orderId === "cover")).toBeDefined();
    // 50万円分だけ売る
    expect(state.positions[2].qty).toBeCloseTo(5000);
  });
});

describe("信用取引", () => {
  const M = positionKey("margin", 1);

  it("信用売りは配当相当額を支払い、貸株料を日割りで払う", () => {
    let s: PortfolioState = { ...initialState(1_000_000), orders: [open("sell", 1_000_000, "margin")] };
    const c = ctx({ carry: { long: 0.025, short: 0.01 } });
    s = advanceDay(s, day([[1, b(100)]]), c).state;
    const { state, events } = advanceDay(s, day([[1, b(100), { dividend: 2 }]]), c);
    expect(events).toContainEqual({ kind: "interest", instrumentId: 1, amount: (1_000_000 * 0.01) / 250 });
    expect(events).toContainEqual({ kind: "dividend_adj", instrumentId: 1, amount: -20_000 });
    // 金利は株等の損失として通算される
    expect(state.tax.realized).toBeCloseTo(-40);
    expect(state.leveraged[M].accrued).toBeCloseTo(-20_000);
  });

  it("信用買いは、返済時に株等の譲渡損益として課税する", () => {
    let s: PortfolioState = { ...initialState(1_000_000), orders: [open("buy", 3_000_000, "margin")] };
    s = advanceDay(s, day([[1, b(100, 110)]]), ctx()).state;
    s = { ...s, orders: [close("sell", 1, "margin")] };
    const { state } = advanceDay(s, day([[1, b(110)]]), ctx());
    expect(state.tax.paid).toBeCloseTo(300_000 * RATE);
    expect(state.futuresTax.paid).toBe(0);
  });

  it("清算評価では、信用・先物も最終日の終値で返済したとみなし、区分ごとに課税する", () => {
    let s: PortfolioState = {
      ...initialState(1_000_000),
      orders: [open("buy", 1_000_000, "margin"), open("sell", 1_000_000, "future", 2)],
    };
    s = advanceDay(s, day([[1, b(100, 120)], [2, b(100, 120)]]), ctx()).state; // 信用 +20万、先物 -20万
    const v = liquidationValue(s, () => 120, ctx());
    expect(v).toBeCloseTo(1_000_000 - 200_000 * RATE);
  });
});
