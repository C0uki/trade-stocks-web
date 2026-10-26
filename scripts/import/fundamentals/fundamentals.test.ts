import { describe, expect, it } from "vitest";
import { latestPerReportDate, sanitize, splitFactorAfter } from "./common";
import { perShareFromXbrlCsv } from "./edinet";
import { annualReportsFromCompanyFacts } from "./sec";

describe("決算の取り込み（共通）", () => {
  it("提出日より後の株式分割だけで割る", () => {
    const splits = [
      { date: "2014-06-09", numerator: 7, denominator: 1 },
      { date: "2020-08-31", numerator: 4, denominator: 1 },
    ];
    expect(splitFactorAfter(splits, "2013-10-30")).toBe(28);
    expect(splitFactorAfter(splits, "2019-10-31")).toBe(4);
    expect(splitFactorAfter(splits, "2021-10-29")).toBe(1);
  });

  it("同じ提出日なら新しい期だけを残し、提出日順に並べる", () => {
    const r = latestPerReportDate([
      { periodEnd: "2010-12-31", reportDate: "2011-02-25", eps: 2, bps: 10 },
      { periodEnd: "2009-12-31", reportDate: "2011-02-25", eps: 1, bps: 9 },
      { periodEnd: "2008-12-31", reportDate: "2009-02-20", eps: 1, bps: 8 },
    ]);
    expect(r.map((x) => x.periodEnd)).toEqual(["2008-12-31", "2010-12-31"]);
  });

  it("ありえない PER・PBR になる値は外す", () => {
    expect(sanitize({ eps: 100, bps: 50 }, 120)).toEqual({ eps: null, bps: 50 });
    expect(sanitize({ eps: 5, bps: 0.1 }, 100)).toEqual({ eps: 5, bps: null });
    expect(sanitize({ eps: -3, bps: 40 }, 100)).toEqual({ eps: -3, bps: 40 });
  });
});

describe("SEC", () => {
  it("通期の EPS を最初の提出値で取り、BPS は株主資本 ÷ 表紙の発行済株式数（種類株は合計）", () => {
    const j = {
      facts: {
        "us-gaap": {
          EarningsPerShareDiluted: {
            units: {
              "USD/shares": [
                { start: "2020-01-01", end: "2020-12-31", val: 2, accn: "a1", form: "10-K", filed: "2021-02-10" },
                { start: "2020-01-01", end: "2020-12-31", val: 2.5, accn: "a2", form: "10-K", filed: "2022-02-10" },
                { start: "2020-10-01", end: "2020-12-31", val: 0.6, accn: "a1", form: "10-K", filed: "2021-02-10" },
              ],
            },
          },
          StockholdersEquity: {
            units: { USD: [{ end: "2020-12-31", val: 1000, accn: "a1", form: "10-K", filed: "2021-02-10" }] },
          },
        },
        dei: {
          EntityCommonStockSharesOutstanding: {
            units: {
              shares: [
                { end: "2021-02-01", val: 60, accn: "a1", form: "10-K", filed: "2021-02-10" },
                { end: "2021-02-01", val: 40, accn: "a1", form: "10-K", filed: "2021-02-10" },
              ],
            },
          },
        },
      },
    };
    expect(annualReportsFromCompanyFacts(j)).toEqual([
      { periodEnd: "2020-12-31", reportDate: "2021-02-10", eps: 2, bps: 10 },
    ]);
  });
});

describe("EDINET", () => {
  const row = (id: string, ctx: string, v: string) => [id, "項目", ctx, "当期", "連結", "期間", "JPY", "円", v].map((c) => `"${c}"`).join("\t");
  it("当期の連結の値を使い、連結がなければ個別を使う", () => {
    const tsv = [
      "header",
      row("jpcrp_cor:BasicEarningsLossPerShareSummaryOfBusinessResults", "Prior1YearDuration", "90.1"),
      row("jpcrp_cor:BasicEarningsLossPerShareSummaryOfBusinessResults", "CurrentYearDuration", "123.45"),
      row("jpcrp_cor:NetAssetsPerShareSummaryOfBusinessResults", "CurrentYearInstant_NonConsolidatedMember", "1,500.5"),
    ].join("\n");
    expect(perShareFromXbrlCsv(tsv)).toEqual({ eps: 123.45, bps: 1500.5 });
  });

  it("IFRS の会社は親会社所有者帰属持分で BPS を取る", () => {
    const tsv = [
      "header",
      row("jpcrp_cor:BasicEarningsLossPerShareIFRSSummaryOfBusinessResults", "CurrentYearDuration", "-12"),
      row("jpcrp_cor:EquityAttributableToOwnersOfParentPerShareIFRSSummaryOfBusinessResults", "CurrentYearInstant", "800"),
    ].join("\n");
    expect(perShareFromXbrlCsv(tsv)).toEqual({ eps: -12, bps: 800 });
  });
});
