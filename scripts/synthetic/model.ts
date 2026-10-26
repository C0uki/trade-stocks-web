/**
 * 架空の相場を数式モデルで生成する。実データは一切使わない。
 *
 * - 世界共通の局面（好況・平常・不況・危機）がマルコフ連鎖で切り替わり、ドリフトと値動きの大きさが変わる
 * - 株の日次リターン＝ 地域因子（世界因子に連動）× β ＋ 業種因子 ＋ 個別要因（ボラティリティ・クラスタリング付き）
 *   ＋ 決算での窓開け ＋ まれなジャンプ。権利落ち日には配当分だけ下がる
 * - 市場ごとに架空の祝日があり、その日は足がない（休場）
 * - 暗号資産は毎日動き、独自のブーム・バスト局面を持ち、歴史の途中から上場する
 * - ETF は各地域の構成銘柄の時価総額加重指数
 * - 為替は平均回帰する対数ランダムウォークで、リスクオフ時に円高になる
 * - 先物（株価指数・商品・債券・為替）は、上の世界の値動き（局面・世界因子・ETF・為替）から作る。
 *   乱数は別系列なので、先物を足しても株・暗号資産・為替の相場は変わらない
 */
import { addDays, isWeekday, type IsoDate, type RawBar } from "../../src/lib/engine/calendar";
import type { AssetKind, Currency, Market } from "../../src/lib/engine/instruments";
import { cryptoAssets, japaneseCompanies, SECTORS, westernCompanies, type Sector } from "./names";
import { Rng } from "./random";

export type SynthInstrument = {
  providerSymbol: string;
  symbol: string;
  name: string;
  kind: AssetKind;
  market: Market;
  currency: Currency;
  sector: string;
  bars: RawBar[];
  dividends: { exDate: IsoDate; amount: number }[];
};

export type SynthWorld = {
  instruments: SynthInstrument[];
  fx: Record<"USD" | "EUR", { date: IsoDate; value: number }[]>;
};

export type WorldOptions = {
  seed: number;
  start: IsoDate;
  years: number;
  counts?: { JP: number; US: number; EU: number; CRYPTO: number };
};

const TD = 252;

type Regime = "bull" | "calm" | "bear" | "crisis";
const REGIME: Record<Regime, { mu: number; vol: number; next: [Regime, number][] }> = {
  bull: { mu: 0.16, vol: 0.8, next: [["calm", 0.004], ["bear", 0.001]] },
  calm: { mu: 0.06, vol: 1.0, next: [["bull", 0.003], ["bear", 0.002]] },
  bear: { mu: -0.2, vol: 1.4, next: [["calm", 0.006], ["bull", 0.002], ["crisis", 0.002]] },
  crisis: { mu: -0.7, vol: 2.6, next: [["bear", 0.02], ["calm", 0.012]] },
};

type CryptoRegime = "boom" | "winter" | "chop";
const CRYPTO_REGIME: Record<CryptoRegime, { mu: number; vol: number; next: [CryptoRegime, number][] }> = {
  boom: { mu: 2.0, vol: 1.1, next: [["winter", 0.006], ["chop", 0.004]] },
  winter: { mu: -1.0, vol: 1.0, next: [["chop", 0.005], ["boom", 0.002]] },
  chop: { mu: 0.1, vol: 0.8, next: [["boom", 0.004], ["winter", 0.003]] },
};

function step<R extends string>(rng: Rng, cur: R, table: Record<R, { next: [R, number][] }>): R {
  let u = rng.next();
  for (const [to, p] of table[cur].next) {
    if (u < p) return to;
    u -= p;
  }
  return cur;
}

/** 市場ごとの架空の祝日（月日）。毎年同じ日に休場する */
function holidays(rng: Rng, market: "JP" | "US" | "EU"): Set<string> {
  const fixed = market === "JP" ? ["01-01", "01-02", "01-03", "05-03", "05-04", "05-05", "12-31"] : ["01-01", "12-25"];
  const extra = market === "JP" ? 9 : market === "US" ? 7 : 6;
  const days = new Set(fixed);
  while (days.size < fixed.length + extra) {
    const m = rng.int(1, 12);
    const d = rng.int(1, 28);
    days.add(`${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  return days;
}

/** 当日の値動き（対数リターン）から OHLC を作る */
function makeBar(rng: Rng, date: IsoDate, prevClose: number, r: number, dailyVol: number, baseVolume: number): RawBar {
  const gap = r * rng.uniform(0.2, 0.5) + rng.normal() * dailyVol * 0.15;
  const open = prevClose * Math.exp(gap);
  const close = prevClose * Math.exp(r);
  const high = Math.max(open, close) * Math.exp(Math.abs(rng.normal()) * dailyVol * 0.45);
  const low = Math.min(open, close) * Math.exp(-Math.abs(rng.normal()) * dailyVol * 0.45);
  const volume = Math.round(baseVolume * Math.exp(rng.normal() * 0.3) * (1 + 8 * Math.abs(r)));
  return { date, open, high, low, close, volume };
}

type Stock = {
  info: { name: string; symbol: string; sector: Sector };
  market: "JP" | "US" | "EU";
  beta: number;
  sectorLoad: number;
  alpha: number;
  idioVar: number;
  idioTarget: number;
  earningsOffset: number;
  listedFrom: number;
  shares: number;
  yieldRate: number;
  divMonths: number[];
  price: number;
  baseVolume: number;
  inst: SynthInstrument;
};

const CURRENCY: Record<"JP" | "US" | "EU", Currency> = { JP: "JPY", US: "USD", EU: "EUR" };
const PRICE_RANGE: Record<"JP" | "US" | "EU", [number, number]> = { JP: [400, 6000], US: [15, 300], EU: [10, 150] };
const DIV_MONTHS: Record<"JP" | "US" | "EU", number[][]> = {
  JP: [[3, 9]],
  US: [[2, 5, 8, 11], [3, 6, 9, 12]],
  EU: [[5], [4, 10]],
};

export function generateWorld(opts: WorldOptions): SynthWorld {
  const rng = new Rng(opts.seed);
  const counts = opts.counts ?? { JP: 30, US: 34, EU: 24, CRYPTO: 7 };
  const totalDays = Math.round(opts.years * 365.25);
  const weekdayCount = Math.round(totalDays * (5 / 7));

  const companies = {
    JP: japaneseCompanies(rng, counts.JP),
    US: westernCompanies(rng, counts.US, "US"),
    EU: westernCompanies(rng, counts.EU, "EU"),
  };
  const holi = { JP: holidays(rng, "JP"), US: holidays(rng, "US"), EU: holidays(rng, "EU") };

  const stocks: Stock[] = [];
  for (const market of ["JP", "US", "EU"] as const) {
    for (const info of companies[market]) {
      const [lo, hi] = PRICE_RANGE[market];
      const idioVol = rng.uniform(0.15, 0.4);
      // 15% の会社は歴史の途中で上場する
      const listedFrom = rng.chance(0.15) ? rng.int(TD * 3, Math.floor(weekdayCount * 0.6)) : 0;
      stocks.push({
        info,
        market,
        beta: rng.uniform(0.6, 1.4),
        sectorLoad: rng.uniform(0.5, 1.2),
        alpha: rng.uniform(-0.06, 0.08),
        idioVar: (idioVol * idioVol) / TD,
        idioTarget: (idioVol * idioVol) / TD,
        earningsOffset: rng.int(0, 62),
        listedFrom,
        shares: Math.exp(rng.uniform(Math.log(1e8), Math.log(5e9))),
        yieldRate: rng.chance(0.15) ? 0 : rng.uniform(0.005, 0.045),
        divMonths: rng.pick(DIV_MONTHS[market]),
        price: Math.exp(rng.uniform(Math.log(lo), Math.log(hi))),
        baseVolume: Math.exp(rng.uniform(Math.log(2e5), Math.log(2e7))),
        inst: {
          providerSymbol: `SYN-${market}-${info.symbol}`,
          symbol: info.symbol,
          name: info.name,
          kind: "stock",
          market,
          currency: CURRENCY[market],
          sector: info.sector,
          bars: [],
          dividends: [],
        },
      });
    }
  }

  const etfs = (["JP", "US", "EU"] as const).map((market) => ({
    market,
    level: 100,
    inst: {
      providerSymbol: `SYN-${market}-ETF`,
      symbol: market === "JP" ? "1300" : market === "US" ? "SYNX" : "SXEF",
      name: market === "JP" ? "架空日本株インデックスETF" : market === "US" ? "架空米国株インデックスETF" : "架空欧州株インデックスETF",
      kind: "etf" as const,
      market,
      currency: CURRENCY[market],
      sector: "ETF",
      bars: [] as RawBar[],
      dividends: [] as { exDate: IsoDate; amount: number }[],
    },
  }));

  const cryptos = cryptoAssets(counts.CRYPTO).map((c) => ({
    beta: rng.uniform(0.6, 1.4),
    idioVol: rng.uniform(0.4, 0.9),
    listedFromDay: rng.int(Math.floor(totalDays * 0.25), Math.floor(totalDays * 0.6)),
    price: Math.exp(rng.uniform(Math.log(0.05), Math.log(50))),
    baseVolume: Math.exp(rng.uniform(Math.log(1e6), Math.log(1e9))),
    inst: {
      providerSymbol: `SYN-CRYPTO-${c.symbol}`,
      symbol: c.symbol,
      name: c.name,
      kind: "crypto" as const,
      market: "CRYPTO" as const,
      currency: "USD" as const,
      sector: "暗号資産",
      bars: [] as RawBar[],
      dividends: [] as { exDate: IsoDate; amount: number }[],
    },
  }));

  const fx = { USD: [] as { date: IsoDate; value: number }[], EUR: [] as { date: IsoDate; value: number }[] };
  let usd = Math.log(rng.uniform(95, 130));
  let eur = Math.log(rng.uniform(110, 150));
  const usdMean = usd;
  const eurMean = eur;

  /** 先物を作るために、平日ごとの世界の状態を記録しておく */
  const path: WorldDay[] = [];

  let regime: Regime = "calm";
  let cryptoRegime: CryptoRegime = "chop";
  let weekdayIndex = -1;
  let lastGlobal = 0;

  for (let day = 0; day < totalDays; day++) {
    const date = addDays(opts.start, day);
    const md = date.slice(5);
    const month = Number(date.slice(5, 7));

    // 暗号資産は毎日動く。株式市場の世界因子とは週末を挟んで弱く連動
    cryptoRegime = step(rng, cryptoRegime, CRYPTO_REGIME);
    const cr = CRYPTO_REGIME[cryptoRegime];
    const cryptoFactor = cr.mu / 365 + rng.normal() * (0.6 / Math.sqrt(365)) * cr.vol + 0.3 * lastGlobal;
    for (const c of cryptos) {
      if (day < c.listedFromDay) continue;
      const vol = c.idioVol / Math.sqrt(365);
      let r = c.beta * cryptoFactor + rng.normal() * vol;
      if (rng.chance(0.004)) r += rng.normal() * 0.2;
      const prev = c.price;
      c.price = prev * Math.exp(r);
      c.inst.bars.push(makeBar(rng, date, prev, r, Math.sqrt(vol * vol + 0.0004), c.baseVolume));
    }

    if (!isWeekday(date)) continue;
    weekdayIndex++;

    regime = step(rng, regime, REGIME);
    const rg = REGIME[regime];
    let global = rg.mu / TD + rng.normal() * (0.12 / Math.sqrt(TD)) * rg.vol;
    if (regime === "crisis" && rng.chance(0.03)) global -= rng.uniform(0.04, 0.1);
    lastGlobal = global;

    const regional = {
      JP: 0.9 * global + rng.normal() * (0.09 / Math.sqrt(TD)),
      US: 1.0 * global + rng.normal() * (0.07 / Math.sqrt(TD)),
      EU: 0.95 * global + rng.normal() * (0.08 / Math.sqrt(TD)),
    };
    const sectorFactor = Object.fromEntries(
      SECTORS.map((s) => [s, rng.normal() * (0.1 / Math.sqrt(TD)) * rg.vol]),
    ) as Record<Sector, number>;

    // 為替：平均回帰＋リスクオフで円高（世界因子が下がると USD/JPY・EUR/JPY が下がる）
    usd += 0.002 * (usdMean - usd) + rng.normal() * (0.09 / Math.sqrt(TD)) + 0.3 * global;
    eur += 0.002 * (eurMean - eur) + rng.normal() * (0.1 / Math.sqrt(TD)) + 0.35 * global;
    fx.USD.push({ date, value: Math.exp(usd) });
    fx.EUR.push({ date, value: Math.exp(eur) });

    const capBefore = { JP: 0, US: 0, EU: 0 };
    const capAfter = { JP: 0, US: 0, EU: 0 };
    const open = { JP: !holi.JP.has(md), US: !holi.US.has(md), EU: !holi.EU.has(md) };

    for (const s of stocks) {
      if (weekdayIndex < s.listedFrom || !open[s.market]) continue;
      const prev = s.price;
      // GARCH(1,1) 風に個別の分散を更新
      const z = rng.normal();
      let r = s.alpha / TD + s.beta * regional[s.market] + s.sectorLoad * sectorFactor[s.info.sector];
      let idio = Math.sqrt(s.idioVar) * z;
      if ((weekdayIndex + s.earningsOffset) % 63 === 0) idio += rng.normal() * 0.05;
      if (rng.chance(0.0015)) idio += rng.normal() * 0.12;
      r += idio;
      s.idioVar = 0.05 * s.idioTarget + 0.08 * idio * idio + 0.87 * s.idioVar;

      // 権利落ち：配当月の最初の取引日（その月の前の取引日が前月）に、配当分だけ下がる
      const prevBar = s.inst.bars[s.inst.bars.length - 1];
      const firstDayOfMonth = !prevBar || Number(prevBar.date.slice(5, 7)) !== month;
      if (s.yieldRate > 0 && firstDayOfMonth && s.divMonths.includes(month) && prevBar) {
        const amount = (prev * s.yieldRate) / s.divMonths.length;
        s.inst.dividends.push({ exDate: date, amount });
        r += Math.log(1 - amount / prev);
      }

      const vol = Math.sqrt(s.idioVar + (0.15 * 0.15) / TD);
      s.price = prev * Math.exp(r);
      s.inst.bars.push(makeBar(rng, date, prev, r, vol, s.baseVolume));
      capBefore[s.market] += prev * s.shares;
      capAfter[s.market] += s.price * s.shares;
    }

    const etfReturn = { JP: 0, US: 0, EU: 0 };
    for (const e of etfs) {
      if (!open[e.market] || capBefore[e.market] === 0) continue;
      const prev = e.level;
      const r = Math.log(capAfter[e.market] / capBefore[e.market]);
      etfReturn[e.market] = r;
      e.level = prev * Math.exp(r);
      e.inst.bars.push(makeBar(rng, date, prev, r, 0.012, 5e6));
    }
    path.push({ date, regime, global, etfReturn, open, usd: Math.exp(usd), eur: Math.exp(eur) });
  }

  return {
    instruments: [
      ...stocks.map((s) => s.inst),
      ...etfs.map((e) => e.inst),
      ...cryptos.map((c) => c.inst),
      ...generateFutures(new Rng(opts.seed ^ 0x5f3759df), path),
    ],
    fx,
  };
}

type WorldDay = {
  date: IsoDate;
  regime: Regime;
  global: number;
  /** 各地域の ETF の対数リターン（休場なら 0） */
  etfReturn: Record<"JP" | "US" | "EU", number>;
  open: Record<"JP" | "US" | "EU", boolean>;
  usd: number;
  eur: number;
};

type FutureSpec = {
  symbol: string;
  name: string;
  sector: "株価指数" | "商品" | "債券" | "為替";
  market: "JP" | "US" | "EU";
  currency: Currency;
  price: number;
  /** その日の対数リターン（休場の日は呼ばない） */
  step: (d: WorldDay, i: number) => number;
};

/** 先物13銘柄。満期のない「つなぎ足」として、1本の連続した価格を作る */
function generateFutures(rng: Rng, path: WorldDay[]): SynthInstrument[] {
  const sq = Math.sqrt(TD);
  const crisis = (d: WorldDay) => (d.regime === "crisis" ? 1 : d.regime === "bear" ? 0.5 : 0);
  // 金利は平均回帰し、リスクオフ（世界因子の下落）で下がる＝債券先物は上がる
  let y10 = rng.uniform(0.02, 0.05);
  let y30 = y10 + rng.uniform(0.003, 0.012);
  const y10Mean = y10;
  const spread30 = y30 - y10;
  const bondYields: { y10: number; y30: number; d10: number; d30: number }[] = [];
  for (const d of path) {
    const shock = rng.normal() * (0.008 / sq);
    const d10 = 0.004 * (y10Mean - y10) + shock + 0.02 * d.global;
    const d30 = d10 * 0.85 + 0.01 * (y10 + spread30 - y30) + rng.normal() * (0.003 / sq);
    y10 = Math.max(0.001, y10 + d10);
    y30 = Math.max(0.002, y30 + d30);
    bondYields.push({ y10, y30, d10, d30 });
  }
  // 商品はそれぞれ独自の値動き＋世界因子への連動＋まれなジャンプ
  const commodity = (vol: number, beta: number, haven: number, jump: number, mean: number) => (d: WorldDay) => {
    let r = beta * d.global + haven * crisis(d) * (0.01 / sq) + rng.normal() * (vol / sq) + mean / TD;
    if (rng.chance(jump)) r += rng.normal() * vol * 0.4;
    return r;
  };
  const gold = commodity(0.15, -0.1, 3, 0.002, 0.02);
  let goldR = 0;
  const specs: FutureSpec[] = [
    { symbol: "JPIF", name: "架空日本株指数先物", sector: "株価指数", market: "JP", currency: "JPY", price: rng.uniform(9000, 30000),
      step: (d) => d.etfReturn.JP + rng.normal() * (0.01 / sq) },
    { symbol: "USIF", name: "架空米国株指数先物", sector: "株価指数", market: "US", currency: "USD", price: rng.uniform(1000, 4000),
      step: (d) => d.etfReturn.US + rng.normal() * (0.01 / sq) },
    { symbol: "USTF", name: "架空米国ハイテク株指数先物", sector: "株価指数", market: "US", currency: "USD", price: rng.uniform(2000, 12000),
      step: (d) => 1.25 * d.etfReturn.US + rng.normal() * (0.1 / sq) },
    { symbol: "EUIF", name: "架空欧州株指数先物", sector: "株価指数", market: "EU", currency: "EUR", price: rng.uniform(2500, 4500),
      step: (d) => d.etfReturn.EU + rng.normal() * (0.01 / sq) },
    { symbol: "GOLD", name: "架空金先物", sector: "商品", market: "US", currency: "USD", price: rng.uniform(300, 1500),
      step: (d) => (goldR = gold(d)) },
    { symbol: "SILV", name: "架空銀先物", sector: "商品", market: "US", currency: "USD", price: rng.uniform(5, 25),
      step: (d) => 1.1 * goldR + 0.1 * d.global + rng.normal() * (0.18 / sq) },
    { symbol: "OIL", name: "架空原油先物", sector: "商品", market: "US", currency: "USD", price: rng.uniform(25, 90),
      step: commodity(0.33, 0.6, -2, 0.004, -0.02) },
    { symbol: "NGAS", name: "架空天然ガス先物", sector: "商品", market: "US", currency: "USD", price: rng.uniform(2, 8),
      step: commodity(0.5, 0.4, 0, 0.008, -0.02) },
    { symbol: "COPR", name: "架空銅先物", sector: "商品", market: "US", currency: "USD", price: rng.uniform(1, 4),
      step: commodity(0.22, 0.6, -1, 0.002, -0.01) },
    { symbol: "UST10", name: "架空米国債10年先物", sector: "債券", market: "US", currency: "USD", price: rng.uniform(105, 130),
      // 価格の変化 ≒ −デュレーション × 金利の変化（＋わずかなキャリー）
      step: (_d, i) => -7.5 * bondYields[i].d10 + (bondYields[i].y10 - 0.02) / TD },
    { symbol: "UST30", name: "架空米国債30年先物", sector: "債券", market: "US", currency: "USD", price: rng.uniform(110, 160),
      step: (_d, i) => -17 * bondYields[i].d30 + (bondYields[i].y30 - 0.02) / TD },
    { symbol: "EURUSD", name: "架空ユーロ／ドル先物", sector: "為替", market: "US", currency: "USD", price: 1,
      step: (d, i) => (i === 0 ? 0 : Math.log(d.eur / d.usd / (path[i - 1].eur / path[i - 1].usd))) },
    { symbol: "JPYUSD", name: "架空円／ドル先物", sector: "為替", market: "US", currency: "USD", price: 1,
      // 1円あたりのドル（×100）。円高で上がる
      step: (d, i) => (i === 0 ? 0 : Math.log(path[i - 1].usd / d.usd)) },
  ];
  // 為替先物の初値は、その日の架空為替から決める
  specs[11].price = path[0].eur / path[0].usd;
  specs[12].price = 100 / path[0].usd;

  const out = specs.map(
    (f): SynthInstrument => ({
      providerSymbol: `SYN-FUT-${f.symbol}`,
      symbol: f.symbol,
      name: f.name,
      kind: "future",
      market: f.market,
      currency: f.currency,
      sector: f.sector,
      bars: [],
      dividends: [],
    }),
  );
  // 休場の日の値動きは、次に取引できる日にまとめて反映する
  const pending = specs.map(() => 0);
  path.forEach((d, i) => {
    specs.forEach((f, j) => {
      // 指数先物はその地域の休場日に休む。商品・債券・為替は米国の休場日に休む
      pending[j] += f.step(d, i);
      if (!d.open[f.market]) return;
      const r = pending[j];
      pending[j] = 0;
      const prev = f.price;
      f.price = prev * Math.exp(r);
      const vol = f.sector === "債券" || f.sector === "為替" ? 0.004 : f.sector === "商品" ? 0.02 : 0.012;
      out[j].bars.push(makeBar(rng, d.date, prev, r, vol, 1e5));
    });
  });
  return out;
}

