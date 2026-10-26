import type { AlignedBar } from "./calendar";
import { buyPrice, sellPrice, type CostRates } from "./costs";
import type { Account } from "./engine";

export type Side = "buy" | "sell";
export type OrderType = "market" | "limit";

/**
 * 注文。数量は円の金額か保有割合で指定する。
 * 現物（account 省略時）
 * - 買い: amount = 手数料込みで使う金額
 * - 売り: amount = 手取りの金額、または fraction = 保有の割合（0〜1）
 * 信用・先物（side は売買の向き。新規売り＝sell・open、売り建玉の返済＝buy・close）
 * - 新規: amount = 建玉の想定元本（円）
 * - 返済: amount = 返済する想定元本、または fraction = 建玉の割合
 * 指値はスプレッド込みの実際の約定値に対する上限・下限。
 */
export type Order = {
  id: string;
  instrumentId: number;
  side: Side;
  type: OrderType;
  limitPrice: number | null;
  amount: number | null;
  fraction: number | null;
  placedDay: number;
  account?: Account;
  action?: "open" | "close";
};

/**
 * その日の足で約定するなら、スプレッド込みの約定値を返す。約定しなければ null。
 * - 成行: 始値で約定
 * - 指値買い: 安値（スプレッド込み）が指値以下なら、始値と指値の安い方で約定
 * - 指値売り: 高値（スプレッド込み）が指値以上なら、始値と指値の高い方で約定
 */
export function matchOrder(order: Order, bar: AlignedBar, rates: CostRates): number | null {
  if (!bar.tradable) return null;
  if (order.side === "buy") {
    const open = buyPrice(bar.open, rates);
    if (order.type === "market") return open;
    const low = buyPrice(bar.low, rates);
    const limit = order.limitPrice!;
    if (low > limit) return null;
    return Math.min(open, limit);
  }
  const open = sellPrice(bar.open, rates);
  if (order.type === "market") return open;
  const high = sellPrice(bar.high, rates);
  const limit = order.limitPrice!;
  if (high < limit) return null;
  return Math.max(open, limit);
}
