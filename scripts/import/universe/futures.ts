import type { UniverseEntry } from "./types";

/**
 * 実データの先物（Yahoo の連結先物＝期近のつなぎ足）。
 * 乗り換え（ロール）の日を見分けられないので、さかのぼった補正はせずにそのまま使う。
 * ユーロ・ストックス50は先物が取れないので、指数の値で代用する。
 */
const f = (
  providerSymbol: string,
  symbol: string,
  name: string,
  sector: "株価指数" | "商品" | "債券" | "為替",
  market: UniverseEntry["market"] = "US",
  currency: UniverseEntry["currency"] = "USD",
): UniverseEntry => ({ providerSymbol, symbol, name, kind: "future", market, currency, sector, indexes: [] });

export const FUTURES: UniverseEntry[] = [
  f("NIY=F", "NK225", "日経225先物（円建て）", "株価指数", "JP", "JPY"),
  f("ES=F", "ES", "S&P500先物", "株価指数"),
  f("NQ=F", "NQ", "NASDAQ100先物", "株価指数"),
  f("^STOXX50E", "SX5E", "ユーロ・ストックス50（指数で代用）", "株価指数", "EU", "EUR"),
  f("GC=F", "GC", "金先物", "商品"),
  f("SI=F", "SI", "銀先物", "商品"),
  f("CL=F", "CL", "WTI原油先物", "商品"),
  f("NG=F", "NG", "天然ガス先物", "商品"),
  f("HG=F", "HG", "銅先物", "商品"),
  f("ZN=F", "ZN", "米国10年債先物", "債券"),
  f("ZB=F", "ZB", "米国30年債先物", "債券"),
  f("6E=F", "6E", "ユーロ／ドル先物", "為替"),
  f("6J=F", "6J", "円／ドル先物", "為替"),
];
