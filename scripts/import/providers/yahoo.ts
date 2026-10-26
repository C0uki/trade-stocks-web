import YahooFinance from "yahoo-finance2";
import { toIso, type IsoDate } from "../../../src/lib/engine/calendar";
import type { DailyData, DataProvider } from "../provider";

/**
 * Yahoo Finance（非公式API）。利用規約上、再配布はできないので開発・身内公開専用。
 * close は分割補正済み、配当も分割補正済みの金額で返ってくる。
 */
export class YahooProvider implements DataProvider {
  readonly name = "yahoo";
  private yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

  async fetchDaily(providerSymbol: string, from: IsoDate, to: IsoDate): Promise<DailyData> {
    const query = { period1: from, period2: to, interval: "1d", events: "div|split" } as const;
    const fetch = () => this.yf.chart(providerSymbol, { ...query });
    // 一部の指数（^STOXX50E など）は応答の形がライブラリの検証に通らないので、そのときだけ検証を切って取り直す
    const r = await fetch().catch((e: Error) => {
      if (e.name !== "FailedYahooValidationError") throw e;
      return this.yf.chart(providerSymbol, { ...query }, { validateResult: false }) as ReturnType<typeof fetch>;
    });
    // タイムスタンプは取引所の現地時刻の始まりなので、オフセットを足して現地日付にする
    const offsetMs = (r.meta.gmtoffset ?? 0) * 1000;
    const day = (d: Date) => toIso(d.getTime() + offsetMs);
    const seen = new Set<string>();
    const bars = r.quotes.flatMap((q) => {
      if (q.open == null || q.high == null || q.low == null || q.close == null) return [];
      const date = day(q.date);
      if (seen.has(date)) return [];
      seen.add(date);
      return [{ date, open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }];
    });
    return {
      currency: r.meta.currency ?? "",
      bars,
      dividends: (r.events?.dividends ?? []).map((d) => ({ exDate: day(d.date), amount: d.amount })),
      splits: (r.events?.splits ?? []).map((s) => ({
        date: day(s.date),
        numerator: s.numerator,
        denominator: s.denominator,
      })),
    };
  }

  async fetchFx(currency: "USD" | "EUR", from: IsoDate, to: IsoDate) {
    const symbol = currency === "USD" ? "JPY=X" : "EURJPY=X";
    const { bars } = await this.fetchDaily(symbol, from, to);
    return bars.map((b) => ({ date: b.date, value: b.close }));
  }
}
