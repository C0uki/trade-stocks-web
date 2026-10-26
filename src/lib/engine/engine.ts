import type { AlignedBar } from "./calendar";
import { buyForAmount, buyPrice, feeRate, qtyForNetProceeds, sellPrice, sellQty, type CostRates } from "./costs";
import { matchOrder, type Order } from "./orders";
import { dividendWithholding, emptyTax, settleRealized, type TaxState } from "./tax";

/**
 * 取引の区分。
 * - cash：現物（買いだけ）
 * - margin：信用取引（株・ETF・暗号資産の買い・売り）
 * - future：先物（買い・売り）
 * 信用・先物は証拠金取引で、1銘柄につき買いか売りのどちらか1つだけ持てる（両建てなし）。
 */
export type Account = "cash" | "margin" | "future";
export type LeveragedAccount = Exclude<Account, "cash">;

/** 現物の保有。価格はすべて指数（1口＝指数値の円）。costBasis は手数料込みの取得総額 */
export type Position = { qty: number; costBasis: number };

/**
 * 信用・先物の建玉。毎日の終値で値洗いし、損益をその日のうちに現金へ反映する。
 * 税の上では、返済したときに「建ててからの損益の累計（accrued）」が譲渡損益として確定する。
 */
export type LeveragedPosition = {
  instrumentId: number;
  account: LeveragedAccount;
  side: "long" | "short";
  qty: number;
  /** 平均建値（表示用） */
  entryPrice: number;
  /** 最後に値洗いした価格 */
  mark: number;
  /** 建ててから現金に反映した損益の累計。建てたときの手数料と配当の調整額を含む */
  accrued: number;
};

export type PortfolioState = {
  cash: number;
  positions: Record<number, Position>;
  /** 信用・先物の建玉。キーは positionKey(account, instrumentId) */
  leveraged: Record<string, LeveragedPosition>;
  /** 株等（現物・信用）の譲渡損益の税 */
  tax: TaxState;
  /** 先物の損益の税（株等とは通算しない） */
  futuresTax: TaxState;
  orders: Order[];
  /** 追証が出ている（前日の終値で証拠金が足りなかった） */
  marginCall: boolean;
  /** 翌営業日の始値で信用・先物をすべて強制決済する */
  forceClose: boolean;
};

/**
 * ある1日の、銘柄ごとの市場データ（指数換算済み）。
 * fx は外貨建て先物の損益を円に直す倍率（開始日の為替に対するその日の為替）。それ以外は 1
 */
export type DayMarket = Map<number, { bar: AlignedBar; dividend: number; fx?: number }>;

export type CancelReason = "no_cash" | "no_position" | "margin_call" | "opposite_position" | "forced_close";

export type LedgerEvent =
  | { kind: "dividend"; instrumentId: number; gross: number; tax: number }
  | {
      kind: "trade";
      orderId: string;
      instrumentId: number;
      account: Account;
      action: "open" | "close";
      side: "buy" | "sell";
      qty: number;
      price: number;
      gross: number;
      fees: number;
      realizedPnl: number;
    }
  | { kind: "tax"; amount: number; bucket: "stock" | "future" }
  | { kind: "cancel"; orderId: string; reason: CancelReason }
  /** 信用の買い方金利・貸株料 */
  | { kind: "interest"; instrumentId: number; amount: number }
  /** 信用建玉の配当の調整額（買いは受け取り、売りは支払いで、正負で表す） */
  | { kind: "dividend_adj"; instrumentId: number; amount: number }
  | { kind: "margin_call"; level: "call" | "emergency" | "unresolved"; required: number; cash: number };

export type EngineContext = {
  rates: (instrumentId: number) => CostRates;
  taxRate: number;
  /** 必要証拠金の率（建玉の時価に対する割合） */
  marginRate?: (instrumentId: number, account: LeveragedAccount) => number;
  /** 信用の年率コスト（買い方金利・貸株料）。営業日ごとに 1/250 を徴収する */
  carry?: { long: number; short: number };
};

/** 端数口の誤差で残る極小の保有を消すしきい値 */
const DUST_QTY = 1e-9;
/** 1円未満の買い付け・新規建ては行わない */
const MIN_ORDER_YEN = 1;
/** 1年の営業日数（信用の金利の日割り） */
const DAYS_PER_YEAR = 250;
/** 証拠金がこの割合を下回ったら、追証の猶予なしで強制決済する */
export const EMERGENCY_MARGIN_LEVEL = 0.3;

export function positionKey(account: LeveragedAccount, instrumentId: number): string {
  return `${account}:${instrumentId}`;
}

export function initialState(cash: number): PortfolioState {
  return {
    cash,
    positions: {},
    leveraged: {},
    tax: emptyTax(),
    futuresTax: emptyTax(),
    orders: [],
    marginCall: false,
    forceClose: false,
  };
}

function clone(s: PortfolioState): PortfolioState {
  return {
    cash: s.cash,
    positions: Object.fromEntries(Object.entries(s.positions).map(([k, p]) => [k, { ...p }])),
    leveraged: Object.fromEntries(Object.entries(s.leveraged ?? {}).map(([k, p]) => [k, { ...p }])),
    tax: { ...s.tax },
    futuresTax: { ...(s.futuresTax ?? emptyTax()) },
    orders: s.orders.map((o) => ({ ...o })),
    marginCall: s.marginCall ?? false,
    forceClose: s.forceClose ?? false,
  };
}

const sign = (p: Pick<LeveragedPosition, "side">) => (p.side === "long" ? 1 : -1);
const marginRateOf = (ctx: EngineContext, p: Pick<LeveragedPosition, "instrumentId" | "account">) =>
  ctx.marginRate ? ctx.marginRate(p.instrumentId, p.account) : 1;

/** 建玉の時価（円）。外貨建て先物は fx でその日の円に直す */
function notional(p: LeveragedPosition, price: number, fx: number): number {
  return p.qty * price * fx;
}

/** 必要証拠金（各建玉の最後の値洗い価格で計算） */
export function requiredMargin(s: PortfolioState, ctx: EngineContext, fx: (id: number) => number = () => 1): number {
  let req = 0;
  for (const p of Object.values(s.leveraged ?? {})) req += notional(p, p.mark, fx(p.instrumentId)) * marginRateOf(ctx, p);
  return req;
}

/** 値洗い：前回の値洗い価格からの損益を現金に反映する */
function markTo(s: PortfolioState, p: LeveragedPosition, price: number, fx: number) {
  const delta = sign(p) * p.qty * (price - p.mark) * fx;
  s.cash += delta;
  p.accrued += delta;
  p.mark = price;
}

function settle(s: PortfolioState, events: LedgerEvent[], bucket: "stock" | "future", pnl: number, ctx: EngineContext) {
  const current = bucket === "stock" ? s.tax : s.futuresTax;
  const settled = settleRealized(current, pnl, ctx.taxRate);
  if (bucket === "stock") s.tax = settled.state;
  else s.futuresTax = settled.state;
  if (settled.delta !== 0) {
    s.cash -= settled.delta;
    events.push({ kind: "tax", amount: settled.delta, bucket });
  }
}

const bucketOf = (account: Account) => (account === "future" ? "future" : "stock");

/** 建玉の一部（qty）を price で返済する。値洗い・手数料・損益の確定・税の精算まで行う */
function closeLeveraged(
  s: PortfolioState,
  events: LedgerEvent[],
  ctx: EngineContext,
  key: string,
  qty: number,
  price: number,
  fx: number,
  orderId: string,
) {
  const p = s.leveraged[key];
  markTo(s, p, price, fx);
  const rates = ctx.rates(p.instrumentId);
  const gross = qty * price * fx;
  const fees = gross * feeRate(rates);
  s.cash -= fees;
  const share = qty / p.qty;
  const realized = p.accrued * share - fees;
  p.accrued -= p.accrued * share;
  p.qty -= qty;
  if (p.qty <= DUST_QTY) delete s.leveraged[key];
  events.push({
    kind: "trade",
    orderId,
    instrumentId: p.instrumentId,
    account: p.account,
    action: "close",
    side: p.side === "long" ? "sell" : "buy",
    qty,
    price,
    gross,
    fees,
    realizedPnl: realized,
  });
  settle(s, events, bucketOf(p.account), realized, ctx);
}

/**
 * 1営業日進める。順序は
 * 1. 信用の金利・貸株料（前日終値の建玉に対して）
 * 2. 配当（現物は源泉徴収後に入金、信用は調整額を受け払い）
 * 3. 強制決済（前日の終値で決まっていれば、始値で信用・先物をすべて返済）
 * 4. 売り・返済 → 買い・新規（それぞれ発注順）。返済・売却ごとに税を精算
 * 5. 終値で値洗いし、証拠金を判定（追証・強制決済の予約）
 * 約定しなかった注文（休場・指値未達）は残る。
 */
export function advanceDay(
  prev: PortfolioState,
  market: DayMarket,
  ctx: EngineContext,
): { state: PortfolioState; events: LedgerEvent[] } {
  const s = clone(prev);
  const events: LedgerEvent[] = [];
  const fxOf = (id: number) => market.get(id)?.fx ?? 1;

  // 1. 金利・貸株料
  for (const p of Object.values(s.leveraged)) {
    if (p.account !== "margin" || !ctx.carry) continue;
    const rate = p.side === "long" ? ctx.carry.long : ctx.carry.short;
    const amount = (notional(p, p.mark, 1) * rate) / DAYS_PER_YEAR;
    if (amount <= 0) continue;
    s.cash -= amount;
    events.push({ kind: "interest", instrumentId: p.instrumentId, amount });
    settle(s, events, "stock", -amount, ctx);
  }

  // 2. 配当
  for (const [idStr, pos] of Object.entries(s.positions)) {
    const id = Number(idStr);
    const dividend = market.get(id)?.dividend ?? 0;
    if (dividend <= 0 || pos.qty <= 0) continue;
    const gross = dividend * pos.qty;
    const tax = dividendWithholding(gross, ctx.taxRate);
    s.cash += gross - tax;
    events.push({ kind: "dividend", instrumentId: id, gross, tax });
  }
  for (const p of Object.values(s.leveraged)) {
    const dividend = market.get(p.instrumentId)?.dividend ?? 0;
    if (dividend <= 0 || p.account !== "margin") continue;
    const amount = sign(p) * dividend * p.qty;
    s.cash += amount;
    p.accrued += amount;
    events.push({ kind: "dividend_adj", instrumentId: p.instrumentId, amount });
  }

  // 3. 強制決済
  const remaining: Order[] = [];
  let orders = s.orders;
  if (s.forceClose) {
    for (const [key, p] of Object.entries(s.leveraged)) {
      const day = market.get(p.instrumentId);
      if (!day?.bar.tradable) continue;
      const rates = ctx.rates(p.instrumentId);
      const price = p.side === "long" ? sellPrice(day.bar.open, rates) : buyPrice(day.bar.open, rates);
      closeLeveraged(s, events, ctx, key, p.qty, price, fxOf(p.instrumentId), "forced");
    }
    // 信用・先物の注文は取り消す（現物の注文は残す）
    orders = [];
    for (const o of s.orders) {
      if ((o.account ?? "cash") === "cash") orders.push(o);
      else events.push({ kind: "cancel", orderId: o.id, reason: "forced_close" });
    }
    if (Object.keys(s.leveraged).length === 0) s.forceClose = false;
  }

  // 4. 注文
  const isClose = (o: Order) => (o.account ?? "cash") === "cash" ? o.side === "sell" : o.action === "close";
  const ordered = [...orders.filter(isClose), ...orders.filter((o) => !isClose(o))];
  for (const order of ordered) {
    const day = market.get(order.instrumentId);
    if (!day) {
      remaining.push(order);
      continue;
    }
    const rates = ctx.rates(order.instrumentId);
    const price = matchOrder(order, day.bar, rates);
    if (price === null) {
      remaining.push(order);
      continue;
    }
    const account = order.account ?? "cash";
    const fx = day.fx ?? 1;
    if (account === "cash") {
      if (order.side === "buy") buyCash(s, events, ctx, order, price, fxOf);
      else sellCash(s, events, ctx, order, price);
      continue;
    }
    const key = positionKey(account, order.instrumentId);
    const existing = s.leveraged[key];
    if (order.action === "close") {
      const matches = existing && (existing.side === "long" ? "sell" : "buy") === order.side;
      if (!matches) {
        events.push({ kind: "cancel", orderId: order.id, reason: "no_position" });
        continue;
      }
      const want =
        order.fraction !== null ? existing.qty * order.fraction : (order.amount ?? 0) / (price * fx);
      closeLeveraged(s, events, ctx, key, Math.min(want, existing.qty), price, fx, order.id);
      continue;
    }
    // 新規建て
    if (s.marginCall || s.forceClose) {
      events.push({ kind: "cancel", orderId: order.id, reason: "margin_call" });
      continue;
    }
    const side = order.side === "buy" ? "long" : "short";
    if (existing && existing.side !== side) {
      events.push({ kind: "cancel", orderId: order.id, reason: "opposite_position" });
      continue;
    }
    const rate = ctx.marginRate ? ctx.marginRate(order.instrumentId, account) : 1;
    const fr = feeRate(rates);
    // 新規建て後も「現金 ≧ 必要証拠金」を保てる範囲に抑える
    const room = (s.cash - requiredMargin(s, ctx, fxOf)) / (rate + fr);
    const amount = Math.min(order.amount ?? 0, room);
    if (amount < MIN_ORDER_YEN) {
      events.push({ kind: "cancel", orderId: order.id, reason: "no_cash" });
      continue;
    }
    const qty = amount / (price * fx);
    const fees = amount * fr;
    s.cash -= fees;
    if (existing) {
      markTo(s, existing, price, fx);
      existing.entryPrice = (existing.entryPrice * existing.qty + price * qty) / (existing.qty + qty);
      existing.qty += qty;
      existing.accrued -= fees;
    } else {
      s.leveraged[key] = {
        instrumentId: order.instrumentId,
        account,
        side,
        qty,
        entryPrice: price,
        mark: price,
        accrued: -fees,
      };
    }
    events.push({
      kind: "trade",
      orderId: order.id,
      instrumentId: order.instrumentId,
      account,
      action: "open",
      side: order.side,
      qty,
      price,
      gross: amount,
      fees,
      realizedPnl: 0,
    });
  }
  // 発注順を保つ
  const keep = new Set(remaining.map((o) => o.id));
  s.orders = s.orders.filter((o) => keep.has(o.id));

  // 5. 終値で値洗いし、証拠金を判定する
  for (const p of Object.values(s.leveraged)) {
    const day = market.get(p.instrumentId);
    if (day) markTo(s, p, day.bar.close, fxOf(p.instrumentId));
  }
  if (Object.keys(s.leveraged).length === 0) {
    s.marginCall = false;
    s.forceClose = false;
    // 強制決済のあとに現金がマイナスなら、現物を終値で売って埋める
    if (s.cash < 0) coverWithCashPositions(s, events, ctx, market);
  } else if (!s.forceClose) {
    const required = requiredMargin(s, ctx, fxOf);
    if (s.cash < required * EMERGENCY_MARGIN_LEVEL) {
      s.forceClose = true;
      s.marginCall = false;
      events.push({ kind: "margin_call", level: "emergency", required, cash: s.cash });
    } else if (s.cash < required) {
      if (s.marginCall) {
        s.forceClose = true;
        s.marginCall = false;
        events.push({ kind: "margin_call", level: "unresolved", required, cash: s.cash });
      } else {
        s.marginCall = true;
        events.push({ kind: "margin_call", level: "call", required, cash: s.cash });
      }
    } else {
      s.marginCall = false;
    }
  }
  return { state: s, events };
}

function buyCash(
  s: PortfolioState,
  events: LedgerEvent[],
  ctx: EngineContext,
  order: Order,
  price: number,
  fxOf: (id: number) => number,
) {
  const rates = ctx.rates(order.instrumentId);
  const want = order.amount ?? 0;
  // 信用・先物の証拠金に使っている分の現金は使えない
  const free = s.cash - requiredMargin(s, ctx, fxOf);
  const spend = Math.min(want, free);
  if (spend < MIN_ORDER_YEN) {
    events.push({ kind: "cancel", orderId: order.id, reason: "no_cash" });
    return;
  }
  const calc = buyForAmount(spend, price, rates);
  s.cash -= calc.total;
  const pos = s.positions[order.instrumentId] ?? { qty: 0, costBasis: 0 };
  pos.qty += calc.qty;
  pos.costBasis += calc.total;
  s.positions[order.instrumentId] = pos;
  events.push({
    kind: "trade",
    orderId: order.id,
    instrumentId: order.instrumentId,
    account: "cash",
    action: "open",
    side: "buy",
    qty: calc.qty,
    price,
    gross: calc.gross,
    fees: calc.fees,
    realizedPnl: 0,
  });
}

function sellCashQty(
  s: PortfolioState,
  events: LedgerEvent[],
  ctx: EngineContext,
  instrumentId: number,
  qty: number,
  price: number,
  orderId: string,
) {
  const pos = s.positions[instrumentId];
  const rates = ctx.rates(instrumentId);
  const calc = sellQty(qty, price, rates);
  const basis = pos.costBasis * (qty / pos.qty);
  const pnl = calc.net - basis;
  pos.qty -= qty;
  pos.costBasis -= basis;
  if (pos.qty <= DUST_QTY) delete s.positions[instrumentId];
  s.cash += calc.net;
  events.push({
    kind: "trade",
    orderId,
    instrumentId,
    account: "cash",
    action: "close",
    side: "sell",
    qty,
    price,
    gross: calc.gross,
    fees: calc.fees,
    realizedPnl: pnl,
  });
  settle(s, events, "stock", pnl, ctx);
}

function sellCash(s: PortfolioState, events: LedgerEvent[], ctx: EngineContext, order: Order, price: number) {
  const pos = s.positions[order.instrumentId];
  if (!pos || pos.qty <= DUST_QTY) {
    events.push({ kind: "cancel", orderId: order.id, reason: "no_position" });
    return;
  }
  const rates = ctx.rates(order.instrumentId);
  let qty = order.fraction !== null ? pos.qty * order.fraction : qtyForNetProceeds(order.amount ?? 0, price, rates);
  qty = Math.min(qty, pos.qty);
  sellCashQty(s, events, ctx, order.instrumentId, qty, price, order.id);
}

/** 現金のマイナスを、現物を終値（スプレッド込み）で売って埋める */
function coverWithCashPositions(s: PortfolioState, events: LedgerEvent[], ctx: EngineContext, market: DayMarket) {
  for (const idStr of Object.keys(s.positions)) {
    if (s.cash >= 0) return;
    const id = Number(idStr);
    const day = market.get(id);
    if (!day) continue;
    const rates = ctx.rates(id);
    const price = sellPrice(day.bar.close, rates);
    const need = qtyForNetProceeds(-s.cash, price, rates);
    sellCashQty(s, events, ctx, id, Math.min(need, s.positions[id].qty), price, "cover");
  }
}

/** 終値での時価評価（コスト・税は考慮しない）。信用・先物の損益は値洗いで現金に入っている */
export function markToMarket(s: PortfolioState, closes: (id: number) => number | undefined): number {
  let v = s.cash;
  for (const [id, pos] of Object.entries(s.positions)) {
    v += pos.qty * (closes(Number(id)) ?? 0);
  }
  return v;
}

/**
 * 終了時の評価額。最終日の終値で現物を売却し、信用・先物を返済したとみなし（スプレッド・手数料あり）、
 * 含み損益も含めて税を区分ごとに精算した後の資産額を返す。
 */
export function liquidationValue(
  s: PortfolioState,
  closes: (id: number) => number | undefined,
  ctx: EngineContext,
  fx: (id: number) => number = () => 1,
): number {
  let cash = s.cash;
  let stockPnl = 0;
  let futurePnl = 0;
  for (const [idStr, pos] of Object.entries(s.positions)) {
    const id = Number(idStr);
    const rates = ctx.rates(id);
    const price = sellPrice(closes(id) ?? 0, rates);
    const calc = sellQty(pos.qty, price, rates);
    cash += calc.net;
    stockPnl += calc.net - pos.costBasis;
  }
  for (const p of Object.values(s.leveraged ?? {})) {
    const rates = ctx.rates(p.instrumentId);
    const close = closes(p.instrumentId) ?? p.mark;
    const price = p.side === "long" ? sellPrice(close, rates) : buyPrice(close, rates);
    const f = fx(p.instrumentId);
    const variation = sign(p) * p.qty * (price - p.mark) * f;
    const fees = p.qty * price * f * feeRate(rates);
    cash += variation - fees;
    const pnl = p.accrued + variation - fees;
    if (p.account === "future") futurePnl += pnl;
    else stockPnl += pnl;
  }
  cash -= settleRealized(s.tax, stockPnl, ctx.taxRate).delta;
  cash -= settleRealized(s.futuresTax ?? emptyTax(), futurePnl, ctx.taxRate).delta;
  return cash;
}
