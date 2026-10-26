import { describe, expect, it } from "vitest";
import { latestReport, trailingDividendYield, valuationRatios } from "./fundamentals";
import { indexToJpy, localAmountToIndex, toIndex, toJpy } from "./pricing";
import { macd, rsi, sma } from "../indicators";

describe("pricing", () => {
  it("円換算してから開始日=100に指数化し、元に戻せる", () => {
    const bar = { open: 10, high: 12, low: 9, close: 11, volume: 1, tradable: true };
    const jpy = toJpy(bar, 150); // 1650円
    const idx = toIndex(jpy, 1650);
    expect(idx.close).toBeCloseTo(100);
    expect(indexToJpy(idx.open, 1650)).toBeCloseTo(1500);
    expect(localAmountToIndex(0.5, 150, 1650)).toBeCloseTo((75 / 1650) * 100);
  });
});

describe("fundamentals", () => {
  it("直近1年の配当で利回りを計算", () => {
    const divs = [
      { exDate: "2023-03-01", amount: 9 },
      { exDate: "2023-09-01", amount: 1 },
      { exDate: "2024-03-01", amount: 1 },
      { exDate: "2024-06-01", amount: 5 },
    ];
    expect(trailingDividendYield(divs, "2024-03-01", 100)).toBeCloseTo(0.02);
  });

  it("決算発表日より前のレポートは使わない", () => {
    const reports = [
      { reportDate: "2024-02-10", epsTtm: 5, bps: 50 },
      { reportDate: "2024-05-10", epsTtm: 10, bps: 60 },
    ];
    expect(latestReport(reports, "2024-05-09")?.epsTtm).toBe(5);
    expect(valuationRatios(reports, "2024-05-10", 100)).toEqual({ per: 10, pbr: 100 / 60 });
    expect(valuationRatios(reports, "2024-01-01", 100)).toEqual({ per: null, pbr: null });
  });
});

describe("indicators", () => {
  it("SMA", () => {
    expect(sma([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]);
  });
  it("RSI は上昇のみなら100", () => {
    const r = rsi(Array.from({ length: 20 }, (_, i) => i), 14);
    expect(r[13]).toBeNull();
    expect(r[14]).toBe(100);
  });
  it("MACD の長さが入力と同じ", () => {
    const vals = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 10);
    const m = macd(vals);
    expect(m.macd).toHaveLength(60);
    expect(m.signal[33]).not.toBeNull();
    expect(m.signal[32]).toBeNull();
  });
});

describe("シナリオから外す期間", () => {
  it("期間が少しでも重なれば外し、重ならなければ外さない", async () => {
    const { isExcludedPeriod } = await import("@/config/game");
    expect(isExcludedPeriod("CL=F", "2019-04-01", "2020-04-01")).toBe(true);
    expect(isExcludedPeriod("CL=F", "2020-06-10", "2021-06-10")).toBe(true);
    expect(isExcludedPeriod("CL=F", "2020-06-16", "2021-06-16")).toBe(false);
    expect(isExcludedPeriod("ES=F", "2019-04-01", "2020-04-01")).toBe(false);
  });
});
