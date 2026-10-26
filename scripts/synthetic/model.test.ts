import { describe, expect, it } from "vitest";
import { isWeekday } from "../../src/lib/engine/calendar";
import { generateWorld } from "./model";

const world = generateWorld({ seed: 42, start: "2001-01-01", years: 12 });
const stocks = world.instruments.filter((i) => i.kind === "stock");
const cryptos = world.instruments.filter((i) => i.kind === "crypto");
const etfs = world.instruments.filter((i) => i.kind === "etf");

function annualVol(closes: number[], perYear: number) {
  const r = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v * perYear);
}

function maxDrawdown(closes: number[]) {
  let peak = closes[0];
  let dd = 0;
  for (const c of closes) {
    peak = Math.max(peak, c);
    dd = Math.max(dd, 1 - c / peak);
  }
  return dd;
}

describe("架空データの生成モデル", () => {
  it("同じシードなら同じ結果、違うシードなら違う結果", () => {
    const a = generateWorld({ seed: 7, start: "2001-01-01", years: 2 });
    const b = generateWorld({ seed: 7, start: "2001-01-01", years: 2 });
    const c = generateWorld({ seed: 8, start: "2001-01-01", years: 2 });
    expect(a).toEqual(b);
    expect(a.instruments[0].bars[10]).not.toEqual(c.instruments[0].bars[10]);
  });

  it("約100銘柄で、記号は重複しない", () => {
    expect(world.instruments.length).toBeGreaterThanOrEqual(95);
    expect(new Set(world.instruments.map((i) => i.providerSymbol)).size).toBe(world.instruments.length);
    expect(new Set(stocks.map((i) => i.name)).size).toBe(stocks.length);
    expect(etfs).toHaveLength(3);
  });

  it("価格は正で、OHLC が整合している", () => {
    const bad = world.instruments.flatMap((inst) =>
      inst.bars.filter(
        (b) =>
          !(b.low > 0) ||
          b.high < Math.max(b.open, b.close) - 1e-9 ||
          b.low > Math.min(b.open, b.close) + 1e-9 ||
          b.volume < 0,
      ),
    );
    expect(bad).toEqual([]);
  });

  it("値動きの大きさとドローダウンが現実的な範囲に収まる", () => {
    for (const s of stocks) {
      const vol = annualVol(s.bars.map((b) => b.close), 252);
      expect(vol).toBeGreaterThan(0.12);
      expect(vol).toBeLessThan(0.9);
    }
    for (const e of etfs) {
      const closes = e.bars.map((b) => b.close);
      const vol = annualVol(closes, 252);
      expect(vol).toBeGreaterThan(0.07);
      expect(vol).toBeLessThan(0.45);
      // 12年あれば一度は大きめの下落がある
      expect(maxDrawdown(closes)).toBeGreaterThan(0.12);
    }
    for (const c of cryptos) {
      expect(annualVol(c.bars.map((b) => b.close), 365)).toBeGreaterThan(0.4);
    }
  });

  it("株は平日だけ、祝日は休場。暗号資産は土日も動く", () => {
    for (const s of stocks.slice(0, 5)) {
      expect(s.bars.every((b) => isWeekday(b.date))).toBe(true);
      const years = s.bars.length / 260;
      // 平日は年約261日。祝日の分だけ少ない
      expect(s.bars.length / years).toBeLessThan(261);
    }
    expect(cryptos.some((c) => c.bars.some((b) => !isWeekday(b.date)))).toBe(true);
  });

  it("配当があり、権利落ち日には配当分下がる", () => {
    const payers = stocks.filter((s) => s.dividends.length > 0);
    expect(payers.length).toBeGreaterThan(stocks.length / 2);
    const s = payers[0];
    const d = s.dividends[3];
    const i = s.bars.findIndex((b) => b.date === d.exDate);
    expect(i).toBeGreaterThan(0);
    expect(d.amount / s.bars[i - 1].close).toBeLessThan(0.05);
  });

  it("途中で上場する銘柄と、途中から始まる暗号資産がある", () => {
    const first = world.instruments.map((i) => i.bars[0]?.date ?? "9999");
    expect(first.some((d) => d > "2004-01-01")).toBe(true);
    expect(cryptos.every((c) => c.bars[0].date > "2003-01-01")).toBe(true);
  });

  it("為替は正で、極端に発散しない", () => {
    for (const series of [world.fx.USD, world.fx.EUR]) {
      const vals = series.map((p) => p.value);
      expect(Math.min(...vals)).toBeGreaterThan(40);
      expect(Math.max(...vals)).toBeLessThan(400);
    }
  });
});

describe("架空の先物", () => {
  const futures = world.instruments.filter((i) => i.kind === "future");
  const closes = (symbol: string) => futures.find((f) => f.symbol === symbol)!.bars.map((b) => b.close);
  const returns = (c: number[]) => c.slice(1).map((v, i) => Math.log(v / c[i]));
  const corr = (a: number[], b: number[]) => {
    const n = Math.min(a.length, b.length);
    const ma = a.slice(0, n).reduce((x, y) => x + y, 0) / n;
    const mb = b.slice(0, n).reduce((x, y) => x + y, 0) / n;
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < n; i++) {
      num += (a[i] - ma) * (b[i] - mb);
      da += (a[i] - ma) ** 2;
      db += (b[i] - mb) ** 2;
    }
    return num / Math.sqrt(da * db);
  };

  it("13銘柄あり、分類が付いている", () => {
    expect(futures).toHaveLength(13);
    expect(new Set(futures.map((f) => f.sector))).toEqual(new Set(["株価指数", "商品", "債券", "為替"]));
  });

  it("先物を足しても、株・暗号資産・為替の相場は変わらない（乱数が別系列）", () => {
    const again = generateWorld({ seed: 42, start: "2001-01-01", years: 12 });
    expect(again.instruments.filter((i) => i.kind !== "future")).toEqual(world.instruments.filter((i) => i.kind !== "future"));
  });

  it("値動きの大きさが資産ごとに現実的な範囲に収まる", () => {
    const vol = (s: string) => annualVol(closes(s), 252);
    expect(vol("UST10")).toBeLessThan(0.15);
    expect(vol("EURUSD")).toBeLessThan(0.2);
    expect(vol("NGAS")).toBeGreaterThan(vol("GOLD"));
    for (const f of futures) expect(vol(f.symbol)).toBeLessThan(0.9);
  });

  it("指数先物は同じ地域の ETF と強く連動し、金と銀も連動する", () => {
    const etf = world.instruments.find((i) => i.providerSymbol === "SYN-US-ETF")!.bars.map((b) => b.close);
    expect(corr(returns(closes("USIF")), returns(etf))).toBeGreaterThan(0.8);
    expect(corr(returns(closes("GOLD")), returns(closes("SILV")))).toBeGreaterThan(0.5);
  });
});

describe("架空の決算", () => {
  it("株だけにあり、発表日は昇順・上場1年後から。PER・PBR は現実的な範囲", () => {
    expect(etfs.every((e) => !e.fundamentals?.length)).toBe(true);
    const pers: number[] = [];
    const pbrs: number[] = [];
    for (const s of stocks) {
      const f = s.fundamentals ?? [];
      expect(f.length).toBeGreaterThan(0);
      expect(f.map((r) => r.reportDate)).toEqual([...f.map((r) => r.reportDate)].sort());
      expect(f[0].reportDate > s.bars[200].date).toBe(true);
      for (const r of f) {
        const close = s.bars.find((b) => b.date === r.reportDate)!.close;
        if (r.epsTtm! > 0) pers.push(close / r.epsTtm!);
        pbrs.push(close / r.bps!);
      }
    }
    const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    expect(median(pers)).toBeGreaterThan(8);
    expect(median(pers)).toBeLessThan(30);
    expect(median(pbrs)).toBeGreaterThan(0.6);
    expect(median(pbrs)).toBeLessThan(5);
  });
});
