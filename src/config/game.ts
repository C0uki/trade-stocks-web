import type { AssetKind, Currency } from "@/lib/engine/instruments";

/** 初期資金（円） */
export const INITIAL_CASH = 10_000_000;

/** シナリオの営業日数（約1年） */
export const SCENARIO_DAYS = 250;

/** 開始前に見せる過去チャートの営業日数（約1年） */
export const PRE_HISTORY_DAYS = 250;

/** 譲渡益・配当にかかる税率（所得税15.315%＋住民税5%） */
export const TAX_RATE = 0.20315;

/** 月間ランキングに載るのに必要な完了シナリオ数 */
export const MIN_SCENARIOS_FOR_RANKING = 3;

/** 架空データの暦の起点。この年を「架空暦1年目」とする */
export const SYNTHETIC_EPOCH = "2001-01-01";

/** 生成する架空の歴史の長さ（年） */
export const SYNTHETIC_YEARS = 30;

/** ランク戦を放棄したときのスコアの上限。放棄時点の成績がこれより良くても、この値に下げる */
export const ABANDON_PENALTY_SCORE = -20;

export type CostSchedule = {
  /** 約定金額に対する手数料率 */
  commission: number;
  /** 片道スプレッド（買いは上乗せ、売りは差し引き） */
  spread: number;
};

/** 資産クラス・市場ごとの取引コスト */
export const COSTS: Record<"JP" | "US" | "EU" | "CRYPTO", CostSchedule> = {
  JP: { commission: 0.001, spread: 0.0005 },
  US: { commission: 0.0045, spread: 0.0005 },
  EU: { commission: 0.0045, spread: 0.0005 },
  CRYPTO: { commission: 0.001, spread: 0.005 },
};

/** 外貨建ての資産を売買するときの為替手数料（片道） */
export const FX_FEE = 0.0025;

export function costScheduleFor(kind: AssetKind, market: string, sector: string | null = null): CostSchedule {
  if (kind === "future") return futureCostSchedule(sector);
  if (kind === "crypto") return COSTS.CRYPTO;
  if (market === "JP" || market === "US" || market === "EU") return COSTS[market];
  return COSTS.US;
}

/** 暗号資産は国内取引所の円建て取引を想定し、為替手数料はかけない */
export function fxFeeFor(kind: AssetKind, currency: Currency): number {
  if (kind === "crypto" || kind === "future" || currency === "JPY") return 0;
  return FX_FEE;
}

/* ───────────── 信用取引・先物 ───────────── */

/** 先物の分類。instruments.sector にこの名前を入れる */
export const FUTURE_SECTORS = ["株価指数", "商品", "債券", "為替"] as const;
export type FutureSector = (typeof FUTURE_SECTORS)[number];

/** 先物の取引コスト（想定元本に対する率）。為替手数料はかけず、損益だけをその日のレートで円に換算する */
export const FUTURE_COSTS: Record<FutureSector, CostSchedule> = {
  株価指数: { commission: 0.00005, spread: 0.0001 },
  商品: { commission: 0.00005, spread: 0.0003 },
  債券: { commission: 0.00005, spread: 0.0001 },
  為替: { commission: 0.00005, spread: 0.0001 },
};

/** 必要証拠金の率（建玉の時価に対する割合） */
export const FUTURE_MARGIN: Record<FutureSector, number> = { 株価指数: 0.1, 商品: 0.1, 債券: 0.05, 為替: 0.05 };
export const MARGIN_TRADING_RATE = { stock: 0.3, crypto: 0.5 } as const;

/** 信用取引の年率コスト：買い方金利と貸株料 */
export const MARGIN_CARRY = { long: 0.028, short: 0.011 } as const;

const futureSector = (sector: string | null): FutureSector =>
  (FUTURE_SECTORS as readonly string[]).includes(sector ?? "") ? (sector as FutureSector) : "株価指数";

export function futureCostSchedule(sector: string | null): CostSchedule {
  return FUTURE_COSTS[futureSector(sector)];
}

export function marginRateFor(kind: AssetKind, sector: string | null): number {
  if (kind === "future") return FUTURE_MARGIN[futureSector(sector)];
  return kind === "crypto" ? MARGIN_TRADING_RATE.crypto : MARGIN_TRADING_RATE.stock;
}

/**
 * シナリオに入れない期間（開始前のチャートを含めて重なったら、その銘柄を外す）。
 * WTI原油の期近は 2020-04-20 にマイナス価格になり、指数化できない（その足は取り込んでいない）
 */
export const EXCLUDED_PERIODS: Record<string, { from: string; to: string }[]> = {
  "CL=F": [{ from: "2020-03-15", to: "2020-06-15" }],
};

/** providerSymbol の銘柄が、期間 [from, to] のシナリオから外れるか */
export function isExcludedPeriod(providerSymbol: string, from: string, to: string): boolean {
  return (EXCLUDED_PERIODS[providerSymbol] ?? []).some((p) => p.from <= to && from <= p.to);
}
