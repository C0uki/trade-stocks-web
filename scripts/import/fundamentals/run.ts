/**
 * 実データの決算（PER・PBR 用の EPS・BPS）の取り込み。株価の取り込み（import:data）のあとに実行する。
 *   SEC_CONTACT_EMAIL=you@example.com npm run import:fundamentals -- --market US
 *   EDINET_API_KEY=... npm run import:fundamentals -- --market JP
 * 欧州株は無料で取れるデータ源がないので対象外。
 */
import "dotenv/config";
import path from "node:path";
import { parseArgs } from "node:util";
import { and, asc, eq, gte } from "drizzle-orm";
import { db, schema } from "../../../src/lib/db";
import { latestPerReportDate, sanitize, splitFactorAfter, type AnnualReport } from "./common";
import { EdinetClient } from "./edinet";
import { SecClient } from "./sec";

const { values: args } = parseArgs({
  options: {
    market: { type: "string", default: "US" },
    symbols: { type: "string" },
  },
});

type Source = { annualReports(symbol: string): Promise<AnnualReport[]> };

function source(market: string): Source {
  if (market === "US") {
    const contact = process.env.SEC_CONTACT_EMAIL;
    if (!contact) throw new Error("SEC_CONTACT_EMAIL（SEC に名乗る問い合わせ先）を設定してください");
    return new SecClient(contact);
  }
  if (market === "JP") {
    const key = process.env.EDINET_API_KEY;
    if (!key) throw new Error("EDINET_API_KEY を設定してください");
    return new EdinetClient(key, path.join(import.meta.dirname, "..", ".cache", "edinet"));
  }
  throw new Error(`未対応の市場です: ${market}`);
}

const market = args.market as "US" | "JP";
const src = source(market);
let targets = await db
  .select()
  .from(schema.instruments)
  .where(and(eq(schema.instruments.dataset, "real"), eq(schema.instruments.market, market), eq(schema.instruments.kind, "stock")))
  .orderBy(asc(schema.instruments.symbol));
if (args.symbols) {
  const want = new Set(args.symbols.split(","));
  targets = targets.filter((t) => want.has(t.symbol) || want.has(t.providerSymbol));
}
console.log(`決算の取り込み: ${market} ${targets.length} 銘柄`);

/** 提出日以降で最初の終値 */
async function closeOnOrAfter(instrumentId: number, date: string): Promise<number | undefined> {
  const [b] = await db
    .select({ close: schema.dailyBars.close })
    .from(schema.dailyBars)
    .where(and(eq(schema.dailyBars.instrumentId, instrumentId), gte(schema.dailyBars.date, date)))
    .orderBy(asc(schema.dailyBars.date))
    .limit(1);
  return b?.close;
}

let ok = 0;
let empty = 0;
let failed = 0;
for (const inst of targets) {
  try {
    const reports = latestPerReportDate(await src.annualReports(inst.symbol));
    const splits = await db.select().from(schema.splits).where(eq(schema.splits.instrumentId, inst.id));
    const rows: (typeof schema.fundamentals.$inferInsert)[] = [];
    for (const r of reports) {
      const f = splitFactorAfter(splits, r.reportDate);
      const adjusted = { eps: r.eps === null ? null : r.eps / f, bps: r.bps === null ? null : r.bps / f };
      const v = sanitize(adjusted, await closeOnOrAfter(inst.id, r.reportDate));
      if (v.eps === null && v.bps === null) continue;
      rows.push({ instrumentId: inst.id, reportDate: r.reportDate, epsTtm: v.eps, bps: v.bps });
    }
    await db.transaction(async (tx) => {
      await tx.delete(schema.fundamentals).where(eq(schema.fundamentals.instrumentId, inst.id));
      if (rows.length) await tx.insert(schema.fundamentals).values(rows);
    });
    if (rows.length) ok++;
    else empty++;
    console.log(`${inst.symbol}: ${rows.length} 件`);
  } catch (e) {
    failed++;
    console.error(`${inst.symbol}: 失敗 ${(e as Error).message.slice(0, 160)}`);
  }
  // SEC は毎秒10回までなので、少し間をあける
  await new Promise((r) => setTimeout(r, 150));
}
console.log(`完了: ${ok} 銘柄 / データなし ${empty} / 失敗 ${failed}`);
process.exit(0);
