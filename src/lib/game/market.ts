import "server-only";
import { and, asc, eq, gt, inArray, lte } from "drizzle-orm";
import { costScheduleFor, fxFeeFor } from "@/config/game";
import { db, schema } from "@/lib/db";
import type { Dataset } from "@/lib/db/schema";
import { addDays, alignBars, carryForward, previousWeekday, type AlignedBar, type IsoDate } from "@/lib/engine/calendar";
import type { CostRates } from "@/lib/engine/costs";
import type { DayMarket } from "@/lib/engine/engine";
import type { Currency, Instrument } from "@/lib/engine/instruments";
import { localAmountToIndex, toIndex, toJpy } from "@/lib/engine/pricing";
import { calIndex } from "./timeline";

/**
 * baseFx は開始日の為替（1通貨単位あたり円）。外貨建て先物は、価格をこのレートで固定して指数化し
 * （＝現地通貨の値動きだけを表す）、損益だけをその日の為替で円に換算する
 */
export type ScenarioInstrument = Instrument & { basePriceJpy: number; baseFx: number | null };

export type ScenarioMarket = {
  dataset: Dataset;
  cal: IsoDate[];
  instruments: Map<number, ScenarioInstrument>;
};

/** 据え置きの元になる足を拾うための遡り日数（長期の売買停止に備えて長め） */
const LOOKBACK_DAYS = 45;

export async function loadScenarioMarket(scenarioId: string, cal: IsoDate[], dataset: Dataset): Promise<ScenarioMarket> {
  const rows = await db
    .select({
      id: schema.instruments.id,
      symbol: schema.instruments.symbol,
      name: schema.instruments.name,
      kind: schema.instruments.kind,
      market: schema.instruments.market,
      currency: schema.instruments.currency,
      sector: schema.instruments.sector,
      basePriceJpy: schema.scenarioInstruments.basePriceJpy,
      baseFx: schema.scenarioInstruments.baseFx,
    })
    .from(schema.scenarioInstruments)
    .innerJoin(schema.instruments, eq(schema.instruments.id, schema.scenarioInstruments.instrumentId))
    .where(eq(schema.scenarioInstruments.scenarioId, scenarioId));
  return { dataset, cal, instruments: new Map(rows.map((r) => [r.id, r])) };
}

export function costRates(inst: Pick<Instrument, "kind" | "market" | "currency" | "sector">): CostRates {
  const c = costScheduleFor(inst.kind, inst.market, inst.sector);
  return { commission: c.commission, spread: c.spread, fxFee: fxFeeFor(inst.kind, inst.currency) };
}

/** 各日の為替（1通貨単位あたり円）。JPY は 1 */
export async function loadFx(dates: readonly IsoDate[], dataset: Dataset): Promise<Record<Currency, (number | null)[]>> {
  const from = addDays(dates[0], -LOOKBACK_DAYS);
  const rows = await db
    .select()
    .from(schema.fxRates)
    .where(
      and(
        eq(schema.fxRates.dataset, dataset),
        gt(schema.fxRates.date, from),
        lte(schema.fxRates.date, dates[dates.length - 1]),
      ),
    )
    .orderBy(asc(schema.fxRates.date));
  const by = (c: string) => rows.filter((r) => r.currency === c).map((r) => ({ date: r.date, value: r.jpyPerUnit }));
  return {
    JPY: dates.map(() => 1),
    USD: carryForward(by("USD"), dates),
    EUR: carryForward(by("EUR"), dates),
  };
}

export type IndexSeries = {
  /** 指数換算の足。データがない日は null */
  bars: (AlignedBar | null)[];
  /** 各日の配当（指数1口あたり） */
  dividends: number[];
  /** 現地通貨の終値（財務指標・実価格表示用） */
  localClose: (number | null)[];
  /** 外貨建て先物の損益を円に直す倍率（その日の為替 ÷ 開始日の為替）。それ以外は 1 */
  fx: number[];
};

/** 価格を開始日の為替で固定して指数化する銘柄（外貨建ての先物） */
export function usesFixedFx(inst: Pick<ScenarioInstrument, "kind" | "currency">): boolean {
  return inst.kind === "future" && inst.currency !== "JPY";
}

/** k=fromK..toK の指数系列を銘柄ごとに作る */
export async function loadSeries(
  m: ScenarioMarket,
  ids: readonly number[],
  fromK: number,
  toK: number,
): Promise<Map<number, IndexSeries>> {
  const out = new Map<number, IndexSeries>();
  if (ids.length === 0 || toK < fromK) return out;
  const dates = m.cal.slice(calIndex(fromK), calIndex(toK) + 1);
  const last = dates[dates.length - 1];
  const [bars, divs, fx] = await Promise.all([
    db
      .select()
      .from(schema.dailyBars)
      .where(
        and(
          inArray(schema.dailyBars.instrumentId, [...ids]),
          gt(schema.dailyBars.date, addDays(dates[0], -LOOKBACK_DAYS)),
          lte(schema.dailyBars.date, last),
        ),
      )
      .orderBy(asc(schema.dailyBars.instrumentId), asc(schema.dailyBars.date)),
    db
      .select()
      .from(schema.dividends)
      .where(
        and(
          inArray(schema.dividends.instrumentId, [...ids]),
          gt(schema.dividends.exDate, previousWeekday(dates[0])),
          lte(schema.dividends.exDate, last),
        ),
      ),
    loadFx(dates, m.dataset),
  ]);

  const rawBy = new Map<number, typeof bars>();
  for (const b of bars) {
    let arr = rawBy.get(b.instrumentId);
    if (!arr) rawBy.set(b.instrumentId, (arr = []));
    arr.push(b);
  }

  for (const id of ids) {
    const inst = m.instruments.get(id);
    if (!inst) continue;
    const aligned = alignBars(rawBy.get(id) ?? [], dates);
    const rates = fx[inst.currency];
    const series: IndexSeries = { bars: [], dividends: dates.map(() => 0), localClose: [], fx: [] };
    const fixed = usesFixedFx(inst) && inst.baseFx ? inst.baseFx : null;
    aligned.forEach((bar, i) => {
      const r = rates[i];
      series.localClose.push(bar ? bar.close : null);
      series.bars.push(bar && r ? toIndex(toJpy(bar, fixed ?? r), inst.basePriceJpy) : null);
      series.fx.push(fixed && r ? r / fixed : 1);
    });
    for (const d of divs) {
      if (d.instrumentId !== id) continue;
      // 権利落ち日 ex は (前の平日, d] に入る日に割り当てる（土日・休場日の配当も次の営業日へ）
      const i = dates.findIndex((day) => d.exDate <= day);
      const r = i >= 0 ? rates[i] : null;
      if (i >= 0 && r) series.dividends[i] += localAmountToIndex(d.amount, r, inst.basePriceJpy);
    }
    out.set(id, series);
  }
  return out;
}

/** エンジンに渡す日ごとの市場データ（k=fromK..toK） */
export function toDayMarkets(series: Map<number, IndexSeries>, length: number): DayMarket[] {
  const days: DayMarket[] = Array.from({ length }, () => new Map());
  for (const [id, s] of series) {
    for (let i = 0; i < length; i++) {
      const bar = s.bars[i];
      if (bar) days[i].set(id, { bar, dividend: s.dividends[i], fx: s.fx[i] });
    }
  }
  return days;
}
