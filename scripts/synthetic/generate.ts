/**
 * 架空の相場を生成して DB に入れる（既存の架空データは消して作り直す）。
 *   npm run generate:synthetic
 *   npm run generate:synthetic -- --seed 2024 --force   # 架空データのシナリオがあっても消して作り直す
 *   npm run generate:synthetic -- --add-missing         # まだない銘柄（例：あとから足した先物）だけを追加する
 *
 * 先物は別の乱数系列で作るので、同じシードなら --add-missing で足しても既存の銘柄の相場は変わらない。
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import { and, count, eq } from "drizzle-orm";
import { SYNTHETIC_EPOCH, SYNTHETIC_YEARS } from "../../src/config/game";
import { db, schema } from "../../src/lib/db";
import { refreshDateRange, upsertInstrument, writeBars, writeDividends, writeFx } from "../import/writer";
import { generateWorld } from "./model";

const { values: args } = parseArgs({
  options: {
    seed: { type: "string", default: "20010101" },
    years: { type: "string", default: String(SYNTHETIC_YEARS) },
    force: { type: "boolean", default: false },
    "add-missing": { type: "boolean", default: false },
  },
});

const addMissing = args["add-missing"];
const [{ n }] = await db
  .select({ n: count() })
  .from(schema.scenarios)
  .where(eq(schema.scenarios.dataset, "synthetic"));
if (n > 0 && !args.force && !addMissing) {
  console.error(`架空データのシナリオが ${n} 件あります。作り直すとそれらも消えるので、--force を付けて実行してください。`);
  process.exit(1);
}

console.log(`生成中: シード ${args.seed}・${args.years} 年分`);
const world = generateWorld({ seed: Number(args.seed), start: SYNTHETIC_EPOCH, years: Number(args.years) });

if (!addMissing) {
  await db.delete(schema.scenarios).where(eq(schema.scenarios.dataset, "synthetic"));
  await db.delete(schema.instruments).where(eq(schema.instruments.dataset, "synthetic"));
  await db.delete(schema.fxRates).where(eq(schema.fxRates.dataset, "synthetic"));
  await writeFx("synthetic", "USD", world.fx.USD);
  await writeFx("synthetic", "EUR", world.fx.EUR);
}

async function writeFundamentals(instrumentId: number, reports: NonNullable<(typeof world.instruments)[number]["fundamentals"]>) {
  for (let i = 0; i < reports.length; i += 1000) {
    await db
      .insert(schema.fundamentals)
      .values(reports.slice(i, i + 1000).map((r) => ({ instrumentId, ...r })))
      .onConflictDoNothing();
  }
}

let rows = 0;
let added = 0;
let withFundamentals = 0;
for (const inst of world.instruments) {
  if (addMissing) {
    const [exists] = await db
      .select({ id: schema.instruments.id })
      .from(schema.instruments)
      .where(and(eq(schema.instruments.dataset, "synthetic"), eq(schema.instruments.providerSymbol, inst.providerSymbol)));
    if (exists) {
      // あとから足した決算だけを入れる（すでにあれば何もしない）
      if (inst.fundamentals?.length) {
        const [{ n: has }] = await db
          .select({ n: count() })
          .from(schema.fundamentals)
          .where(eq(schema.fundamentals.instrumentId, exists.id));
        if (has === 0) {
          await writeFundamentals(exists.id, inst.fundamentals);
          withFundamentals++;
        }
      }
      continue;
    }
  }
  const row = await upsertInstrument({
    dataset: "synthetic",
    providerSymbol: inst.providerSymbol,
    symbol: inst.symbol,
    name: inst.name,
    kind: inst.kind,
    market: inst.market,
    currency: inst.currency,
    sector: inst.sector,
  });
  await writeBars(row.id, inst.bars);
  await writeDividends(row.id, inst.dividends);
  if (inst.fundamentals?.length) {
    await writeFundamentals(row.id, inst.fundamentals);
    withFundamentals++;
  }
  await refreshDateRange(row.id);
  rows += inst.bars.length;
  added++;
}
console.log(`完了: ${added} 銘柄・${rows} 行・決算を入れた銘柄 ${withFundamentals}`);
process.exit(0);
