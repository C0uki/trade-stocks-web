import "server-only";
import { and, asc, desc, eq, gt, lte } from "drizzle-orm";
import { INITIAL_CASH, marginRateFor, SCENARIO_DAYS, TAX_RATE } from "@/config/game";
import { db, schema } from "@/lib/db";
import { addDays } from "@/lib/engine/calendar";
import { EMERGENCY_MARGIN_LEVEL } from "@/lib/engine/engine";
import { trailingDividendYield, valuationRatios } from "@/lib/engine/fundamentals";
import { INDEX_BASE, indexToJpy } from "@/lib/engine/pricing";
import { GameError } from "./errors";
import { costRates, loadScenarioMarket, loadSeries, usesFixedFx, type ScenarioInstrument } from "./market";
import { getScenarioRow, isInsider, isRevealed } from "./service";
import { dateOfDay, fictionalYear, FIRST_DAY, scenarioCalendar } from "./timeline";

/** 円／ドル先物（1円 ≒ 0.007ドル）のような小さな値も桁を落とさずに出す */
const realFmt = (currency: string, value: number) =>
  new Intl.NumberFormat(
    "ja-JP",
    currency === "JPY"
      ? { style: "currency", currency, maximumFractionDigits: 0 }
      : value < 10
        ? { style: "currency", currency, maximumSignificantDigits: 5 }
        : { style: "currency", currency, maximumFractionDigits: 2 },
  ).format(value);

/**
 * 指数価格を実価格の表示文字列にする。外貨建て先物は、開始日の為替で固定して指数化しているので現地通貨で出す
 */
function realPriceText(inst: ScenarioInstrument, indexPrice: number): string {
  if (usesFixedFx(inst) && inst.baseFx) {
    return realFmt(inst.currency, (indexPrice * inst.basePriceJpy) / INDEX_BASE / inst.baseFx);
  }
  return realFmt("JPY", indexToJpy(indexPrice, inst.basePriceJpy));
}

/**
 * クライアントに返すデータはここで組み立てる。
 * 日付は「k 日目」、価格は指数で返し、isRevealed のときだけ実日付・実価格を付ける。
 */

export async function scenarioView(scenarioId: string, userId: string) {
  const s = await getScenarioRow(scenarioId, userId);
  const revealed = isRevealed(s);
  const cal = scenarioCalendar(s.startDate);
  const m = await loadScenarioMarket(s.id, cal, s.dataset);
  const [pos, lev, openOrders, recent, equity] = await Promise.all([
    db.select().from(schema.positions).where(eq(schema.positions.scenarioId, s.id)),
    db.select().from(schema.leveragedPositions).where(eq(schema.leveragedPositions.scenarioId, s.id)),
    db
      .select()
      .from(schema.orders)
      .where(and(eq(schema.orders.scenarioId, s.id), eq(schema.orders.status, "open")))
      .orderBy(asc(schema.orders.createdAt)),
    db
      .select()
      .from(schema.ledger)
      .where(eq(schema.ledger.scenarioId, s.id))
      .orderBy(desc(schema.ledger.id))
      .limit(100),
    db
      .select()
      .from(schema.equityHistory)
      .where(eq(schema.equityHistory.scenarioId, s.id))
      .orderBy(asc(schema.equityHistory.day)),
  ]);
  const series = await loadSeries(
    m,
    [...pos.map((p) => p.instrumentId), ...lev.map((p) => p.instrumentId)],
    s.currentDay,
    s.currentDay,
  );
  const close = (id: number) => series.get(id)?.bars[0]?.close;
  const fxOf = (id: number) => series.get(id)?.fx[0] ?? 1;
  const leveraged = lev.map((p) => {
    const inst = m.instruments.get(p.instrumentId);
    const price = p.mark;
    const value = p.qty * price * fxOf(p.instrumentId);
    return {
      account: p.account,
      instrumentId: p.instrumentId,
      symbol: inst?.symbol ?? "",
      name: inst?.name ?? "",
      side: p.side,
      qty: p.qty,
      entryPrice: p.entryPrice,
      price,
      value,
      /** 建ててからの損益（手数料・配当の調整を含む） */
      pnl: p.accrued,
      margin: inst ? value * marginRateFor(inst.kind, inst.sector) : 0,
      realPrice: revealed && inst ? realPriceText(inst, price) : null,
    };
  });
  const requiredMargin = leveraged.reduce((a, p) => a + p.margin, 0);
  // 信用・先物の損益は値洗いで現金に入っているので、時価評価は現金と現物だけでよい
  const equityNow = s.cash + pos.reduce((a, p) => a + p.qty * (close(p.instrumentId) ?? 0), 0);
  const name = (id: number | null) => (id ? (m.instruments.get(id)?.name ?? "") : "");
  const symbol = (id: number | null) => (id ? (m.instruments.get(id)?.symbol ?? "") : "");
  const realPrice = (id: number | null, indexPrice: number | null) => {
    if (!revealed || !id || indexPrice == null) return null;
    const inst = m.instruments.get(id);
    return inst ? realPriceText(inst, indexPrice) : null;
  };

  return {
    id: s.id,
    mode: s.mode,
    dataset: s.dataset,
    status: s.status,
    currentDay: s.currentDay,
    totalDays: SCENARIO_DAYS,
    revealed,
    period: revealed ? { start: dateOfDay(cal, 0), end: dateOfDay(cal, SCENARIO_DAYS) } : null,
    fictionalPeriod: fictionalPeriod(s, cal),
    currentDate: revealed ? dateOfDay(cal, s.currentDay) : null,
    initialCash: INITIAL_CASH,
    cash: s.cash,
    equity: equityNow,
    taxRate: TAX_RATE,
    tax: { realized: s.taxRealized, paid: s.taxPaid },
    futuresTax: { realized: s.futuresTaxRealized, paid: s.futuresTaxPaid },
    margin: {
      required: requiredMargin,
      /** 現物の買い付けや新規建てに使える現金 */
      free: s.cash - requiredMargin,
      /** 維持率（現金 ÷ 必要証拠金）。建玉がなければ null */
      level: requiredMargin > 0 ? s.cash / requiredMargin : null,
      emergencyLevel: EMERGENCY_MARGIN_LEVEL,
      call: s.marginCall,
      forceClose: s.forceClose,
    },
    leveraged,
    result:
      s.status === "active"
        ? null
        : { finalValue: s.finalValue, benchmarkValue: s.benchmarkValue, score: s.score },
    instrumentCount: m.instruments.size,
    positions: pos.map((p) => {
      const price = close(p.instrumentId) ?? 0;
      return {
        instrumentId: p.instrumentId,
        symbol: symbol(p.instrumentId),
        name: name(p.instrumentId),
        qty: p.qty,
        avgCost: p.costBasis / p.qty,
        price,
        value: p.qty * price,
        pnl: p.qty * price - p.costBasis,
        realPrice: realPrice(p.instrumentId, price),
      };
    }),
    orders: openOrders.map((o) => ({
      id: o.id,
      instrumentId: o.instrumentId,
      symbol: symbol(o.instrumentId),
      name: name(o.instrumentId),
      side: o.side,
      account: o.account,
      action: o.action,
      type: o.type,
      limitPrice: o.limitPrice,
      amount: o.amount,
      fraction: o.fraction,
      placedDay: o.placedDay,
    })),
    ledger: recent.map((l) => ({
      id: l.id,
      day: l.day,
      date: revealed ? dateOfDay(cal, l.day) : null,
      kind: l.kind,
      account: l.account,
      action: l.action,
      instrumentId: l.instrumentId,
      symbol: symbol(l.instrumentId),
      name: name(l.instrumentId),
      side: l.side,
      qty: l.qty,
      price: l.price,
      realPrice: realPrice(l.instrumentId, l.price),
      gross: l.gross,
      fees: l.fees,
      tax: l.tax,
      realizedPnl: l.realizedPnl,
      note: l.note,
    })),
    equityHistory: equity.map((e) => ({ day: e.day, equity: e.equity, benchmark: e.benchmarkEquity })),
  };
}

export type ScenarioView = Awaited<ReturnType<typeof scenarioView>>;

const MARKET_ORDER = ["JP", "US", "EU", "CRYPTO"];

/** 銘柄一覧：当日の指数終値と前日比 */
export async function marketView(scenarioId: string, userId: string) {
  const s = await getScenarioRow(scenarioId, userId);
  const revealed = isRevealed(s);
  const m = await loadScenarioMarket(s.id, scenarioCalendar(s.startDate), s.dataset);
  const series = await loadSeries(m, [...m.instruments.keys()], s.currentDay - 1, s.currentDay);
  return [...m.instruments.values()]
    .map((inst) => {
      const sr = series.get(inst.id);
      const today = sr?.bars[1];
      const prev = sr?.bars[0];
      return {
        id: inst.id,
        symbol: inst.symbol,
        name: inst.name,
        kind: inst.kind,
        market: inst.market,
        sector: inst.sector,
        price: today?.close ?? null,
        change: today && prev ? today.close / prev.close - 1 : null,
        tradable: today?.tradable ?? false,
        realPrice: revealed && today ? realPriceText(inst, today.close) : null,
      };
    })
    .sort((a, b) => MARKET_ORDER.indexOf(a.market) - MARKET_ORDER.indexOf(b.market) || a.symbol.localeCompare(b.symbol));
}

export type MarketRow = Awaited<ReturnType<typeof marketView>>[number];

/** 銘柄詳細：開始前1年＋当日までの日足と、当日時点の財務指標 */
export async function instrumentView(scenarioId: string, userId: string, instrumentId: number) {
  const s = await getScenarioRow(scenarioId, userId);
  const revealed = isRevealed(s);
  const cal = scenarioCalendar(s.startDate);
  const m = await loadScenarioMarket(s.id, cal, s.dataset);
  const inst = m.instruments.get(instrumentId);
  if (!inst) throw new GameError(404, "銘柄が見つかりません");
  const series = (await loadSeries(m, [instrumentId], FIRST_DAY, s.currentDay)).get(instrumentId)!;
  const asOf = dateOfDay(cal, s.currentDay);
  const localClose = series.localClose[series.localClose.length - 1];
  const [divs, reports] = await Promise.all([
    db
      .select()
      .from(schema.dividends)
      .where(
        and(
          eq(schema.dividends.instrumentId, instrumentId),
          gt(schema.dividends.exDate, addDays(asOf, -366)),
          lte(schema.dividends.exDate, asOf),
        ),
      ),
    db
      .select()
      .from(schema.fundamentals)
      .where(and(eq(schema.fundamentals.instrumentId, instrumentId), lte(schema.fundamentals.reportDate, asOf))),
  ]);
  const ratios = localClose ? valuationRatios(reports, asOf, localClose) : { per: null, pbr: null };
  const rates = costRates(inst);

  const bars = series.bars.flatMap((b, i) => {
    if (!b) return [];
    const day = FIRST_DAY + i;
    return [
      {
        day,
        date: revealed ? cal[i] : null,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        tradable: b.tradable,
      },
    ];
  });
  const last = bars[bars.length - 1];
  return {
    id: inst.id,
    symbol: inst.symbol,
    name: inst.name,
    kind: inst.kind,
    market: inst.market,
    currency: inst.currency,
    sector: inst.sector,
    costs: rates,
    marginRate: marginRateFor(inst.kind, inst.sector),
    tradableToday: last?.tradable ?? false,
    bars,
    fundamentals: {
      dividendYield: localClose ? trailingDividendYield(divs, asOf, localClose) : null,
      per: ratios.per,
      pbr: ratios.pbr,
    },
    real: revealed && last ? { close: realPriceText(inst, last.close) } : null,
  };
}

export type InstrumentView = Awaited<ReturnType<typeof instrumentView>>;

/** 自分のシナリオ一覧 */
export async function myScenarios(userId: string) {
  const rows = await db
    .select()
    .from(schema.scenarios)
    .where(eq(schema.scenarios.userId, userId))
    .orderBy(desc(schema.scenarios.createdAt))
    .limit(50);
  const insider = await isInsider(userId);
  return rows
    .filter((s) => s.dataset === "synthetic" || insider)
    .map((s) => {
      const cal = scenarioCalendar(s.startDate);
      const revealed = isRevealed(s);
      return {
        id: s.id,
        mode: s.mode,
        dataset: s.dataset,
        status: s.status,
        currentDay: s.currentDay,
        score: s.score,
        finalValue: s.finalValue,
        createdAt: s.createdAt,
        period: revealed ? { start: dateOfDay(cal, 0), end: dateOfDay(cal, SCENARIO_DAYS) } : null,
        fictionalPeriod: fictionalPeriod(s, cal),
      };
    });
}

/** 架空データの終了後に見せる「架空暦 ○年目〜○年目」 */
function fictionalPeriod(
  s: Pick<typeof schema.scenarios.$inferSelect, "dataset" | "status">,
  cal: readonly string[],
): { startYear: number; endYear: number } | null {
  if (s.dataset !== "synthetic" || s.status === "active") return null;
  return { startYear: fictionalYear(dateOfDay(cal, 0)), endYear: fictionalYear(dateOfDay(cal, SCENARIO_DAYS)) };
}

