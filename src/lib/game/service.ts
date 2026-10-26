import "server-only";
import { and, asc, eq, gte, inArray, lte, max, min, sql } from "drizzle-orm";
import {
  ABANDON_PENALTY_SCORE,
  INITIAL_CASH,
  isExcludedPeriod,
  MARGIN_CARRY,
  marginRateFor,
  PRE_HISTORY_DAYS,
  SCENARIO_DAYS,
  TAX_RATE,
} from "@/config/game";
import { db, schema } from "@/lib/db";
import type { Dataset } from "@/lib/db/schema";
import { addDays, isWeekday, nextWeekday, parseIso, type IsoDate } from "@/lib/engine/calendar";
import {
  advanceDay,
  liquidationValue,
  markToMarket,
  positionKey,
  type EngineContext,
  type LedgerEvent,
  type PortfolioState,
} from "@/lib/engine/engine";
import type { Order } from "@/lib/engine/orders";
import { excessReturnScore, simulateBenchmark } from "@/lib/engine/score";
import { GameError } from "./errors";
import { costRates, loadFx, loadScenarioMarket, loadSeries, toDayMarkets, type ScenarioMarket } from "./market";
import { scenarioCalendar } from "./timeline";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ScenarioRow = typeof schema.scenarios.$inferSelect;

/** 直近のデータは未確定のことがあるので、シナリオの終わりはこれより前にする */
const RECENT_MARGIN_DAYS = 30;
/** 開始前チャートの最初の日にデータがない銘柄も、この日数以内に上場していれば採用する */
const LISTING_GRACE_DAYS = 7;

export function engineContext(m: ScenarioMarket): EngineContext {
  const get = (id: number) => {
    const inst = m.instruments.get(id);
    if (!inst) throw new Error(`unknown instrument ${id}`);
    return inst;
  };
  return {
    taxRate: TAX_RATE,
    rates: (id) => costRates(get(id)),
    marginRate: (id) => {
      const inst = get(id);
      return marginRateFor(inst.kind, inst.sector);
    },
    carry: MARGIN_CARRY,
  };
}

/** day0 として選べる範囲（そのデータの全期間から、前後の余白を除いたもの） */
export async function selectableRange(dataset: Dataset): Promise<{ min: IsoDate; max: IsoDate } | null> {
  const [r] = await db
    .select({ first: min(schema.instruments.firstDate), last: max(schema.instruments.lastDate) })
    .from(schema.instruments)
    .where(eq(schema.instruments.dataset, dataset));
  if (!r?.first || !r.last) return null;
  // 平日数を暦日に直すざっくりした換算（7/5 倍）に余裕を足す
  const toCal = (weekdays: number) => Math.ceil((weekdays * 7) / 5) + 7;
  const lo = addDays(r.first, toCal(PRE_HISTORY_DAYS));
  const hi = addDays(r.last, -toCal(SCENARIO_DAYS) - RECENT_MARGIN_DAYS);
  if (lo > hi) return null;
  return { min: isWeekday(lo) ? lo : nextWeekday(lo), max: hi };
}

function randomWeekday(lo: IsoDate, hi: IsoDate): IsoDate {
  const span = (parseIso(hi) - parseIso(lo)) / 86_400_000;
  for (;;) {
    const d = addDays(lo, Math.floor(Math.random() * (span + 1)));
    if (isWeekday(d)) return d;
  }
}

export async function createScenario(
  userId: string,
  input: { mode: "ranked" | "practice"; dataset: Dataset; startDate?: IsoDate; showReal?: boolean },
): Promise<string> {
  const { dataset } = input;
  if (dataset === "real" && !(await isInsider(userId))) {
    throw new GameError(403, "実データで遊べるのは招待された人だけです");
  }
  if (dataset === "synthetic" && (input.startDate || input.showReal)) {
    throw new GameError(400, "架空データでは期間の指定や実価格の表示はできません");
  }
  const range = await selectableRange(dataset);
  if (!range) throw new GameError(503, "市場データがまだ取り込まれていません");
  let day0: IsoDate;
  if (input.mode === "practice" && input.startDate) {
    if (input.startDate < range.min || input.startDate > range.max) {
      throw new GameError(400, `開始日は ${range.min} 〜 ${range.max} の範囲で選んでください`);
    }
    day0 = isWeekday(input.startDate) ? input.startDate : nextWeekday(input.startDate);
  } else {
    day0 = randomWeekday(range.min, range.max);
  }
  const cal = scenarioCalendar(day0);
  const first = cal[0];
  const last = cal[cal.length - 1];

  // 期間の最初から最後までデータがある銘柄だけを使う
  const candidates = await db
    .select({
      id: schema.instruments.id,
      currency: schema.instruments.currency,
      providerSymbol: schema.instruments.providerSymbol,
    })
    .from(schema.instruments)
    .where(
      and(
        eq(schema.instruments.dataset, dataset),
        lte(schema.instruments.firstDate, addDays(first, LISTING_GRACE_DAYS)),
        gte(schema.instruments.lastDate, last),
      ),
    );
  const eligible = candidates.filter((c) => !isExcludedPeriod(c.providerSymbol, first, last));
  if (eligible.length === 0) throw new GameError(503, "この期間に使える銘柄がありません");

  // 基準値＝開始日の円換算終値（開始日以前で最新の終値）
  const closes = await db.execute<{ instrument_id: number; close: number }>(sql`
    select distinct on (instrument_id) instrument_id, close
    from ${schema.dailyBars}
    where instrument_id in (${sql.join(
      eligible.map((e) => sql`${e.id}`),
      sql`, `,
    )})
      and date <= ${day0} and date > ${addDays(day0, -45)}
    order by instrument_id, date desc
  `);
  const fx = await loadFx([day0], dataset);
  const closeBy = new Map(closes.map((r) => [Number(r.instrument_id), Number(r.close)]));
  const members = eligible.flatMap((e) => {
    const c = closeBy.get(e.id);
    const r = fx[e.currency][0];
    return c && r ? [{ instrumentId: e.id, basePriceJpy: c * r, baseFx: r }] : [];
  });

  return db.transaction(async (tx) => {
    if (input.mode === "ranked") {
      const [active] = await tx
        .select({ id: schema.scenarios.id })
        .from(schema.scenarios)
        .where(
          and(
            eq(schema.scenarios.userId, userId),
            eq(schema.scenarios.dataset, dataset),
            eq(schema.scenarios.mode, "ranked"),
            eq(schema.scenarios.status, "active"),
          ),
        );
      if (active) throw new GameError(409, "進行中のランク戦があります。終えるか放棄してから始めてください");
    }
    const [s] = await tx
      .insert(schema.scenarios)
      .values({
        userId,
        mode: input.mode,
        dataset,
        showReal: input.mode === "practice" && !!input.showReal,
        startDate: day0,
        cash: INITIAL_CASH,
      })
      .returning({ id: schema.scenarios.id });
    for (let i = 0; i < members.length; i += 1000) {
      await tx.insert(schema.scenarioInstruments).values(members.slice(i, i + 1000).map((m) => ({ scenarioId: s.id, ...m })));
    }
    await tx.insert(schema.equityHistory).values({ scenarioId: s.id, day: 0, equity: INITIAL_CASH });
    return s.id;
  });
}

async function lockScenario(tx: Tx, scenarioId: string, userId: string): Promise<ScenarioRow> {
  if (!UUID.test(scenarioId)) throw new GameError(404, "シナリオが見つかりません");
  const [s] = await tx
    .select()
    .from(schema.scenarios)
    .where(and(eq(schema.scenarios.id, scenarioId), eq(schema.scenarios.userId, userId)))
    .for("update");
  return checkAccess(s, userId);
}

/** 実データのシナリオは、持ち主が今も身内のときだけ触れる（取り消された人には存在しないものとして扱う） */
async function checkAccess(s: ScenarioRow | undefined, userId: string): Promise<ScenarioRow> {
  if (!s || (s.dataset === "real" && !(await isInsider(userId)))) {
    throw new GameError(404, "シナリオが見つかりません");
  }
  return s;
}

export async function isInsider(userId: string): Promise<boolean> {
  const [u] = await db
    .select({ isInsider: schema.users.isInsider })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return !!u?.isInsider;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getScenarioRow(scenarioId: string, userId: string): Promise<ScenarioRow> {
  if (!UUID.test(scenarioId)) throw new GameError(404, "シナリオが見つかりません");
  const [s] = await db
    .select()
    .from(schema.scenarios)
    .where(and(eq(schema.scenarios.id, scenarioId), eq(schema.scenarios.userId, userId)));
  return checkAccess(s, userId);
}

async function loadState(tx: Tx, s: ScenarioRow): Promise<PortfolioState> {
  const [pos, lev, ords] = await Promise.all([
    tx.select().from(schema.positions).where(eq(schema.positions.scenarioId, s.id)),
    tx.select().from(schema.leveragedPositions).where(eq(schema.leveragedPositions.scenarioId, s.id)),
    tx
      .select()
      .from(schema.orders)
      .where(and(eq(schema.orders.scenarioId, s.id), eq(schema.orders.status, "open")))
      .orderBy(asc(schema.orders.createdAt)),
  ]);
  return {
    cash: s.cash,
    tax: { realized: s.taxRealized, paid: s.taxPaid },
    futuresTax: { realized: s.futuresTaxRealized, paid: s.futuresTaxPaid },
    marginCall: s.marginCall,
    forceClose: s.forceClose,
    positions: Object.fromEntries(pos.map((p) => [p.instrumentId, { qty: p.qty, costBasis: p.costBasis }])),
    leveraged: Object.fromEntries(
      lev.map((p) => [
        positionKey(p.account, p.instrumentId),
        {
          instrumentId: p.instrumentId,
          account: p.account,
          side: p.side,
          qty: p.qty,
          entryPrice: p.entryPrice,
          mark: p.mark,
          accrued: p.accrued,
        },
      ]),
    ),
    orders: ords.map(
      (o): Order => ({
        id: o.id,
        instrumentId: o.instrumentId,
        side: o.side,
        type: o.type,
        limitPrice: o.limitPrice,
        amount: o.amount,
        fraction: o.fraction,
        placedDay: o.placedDay,
        account: o.account,
        action: o.action ?? undefined,
      }),
    ),
  };
}

async function saveState(tx: Tx, s: ScenarioRow, state: PortfolioState, day: number) {
  await tx.delete(schema.positions).where(eq(schema.positions.scenarioId, s.id));
  const pos = Object.entries(state.positions).map(([id, p]) => ({
    scenarioId: s.id,
    instrumentId: Number(id),
    qty: p.qty,
    costBasis: p.costBasis,
  }));
  if (pos.length) await tx.insert(schema.positions).values(pos);
  await tx.delete(schema.leveragedPositions).where(eq(schema.leveragedPositions.scenarioId, s.id));
  const lev = Object.values(state.leveraged).map((p) => ({ scenarioId: s.id, ...p }));
  if (lev.length) await tx.insert(schema.leveragedPositions).values(lev);
  await tx
    .update(schema.scenarios)
    .set({
      cash: state.cash,
      taxRealized: state.tax.realized,
      taxPaid: state.tax.paid,
      futuresTaxRealized: state.futuresTax.realized,
      futuresTaxPaid: state.futuresTax.paid,
      marginCall: state.marginCall,
      forceClose: state.forceClose,
      currentDay: day,
    })
    .where(eq(schema.scenarios.id, s.id));
}

async function recordEvents(tx: Tx, scenarioId: string, day: number, events: LedgerEvent[]) {
  if (events.length === 0) return;
  const rows = events.map((e) => {
    switch (e.kind) {
      case "trade":
        return {
          scenarioId,
          day,
          kind: e.kind,
          // 強制決済・不足金の穴埋めには注文がない
          orderId: UUID.test(e.orderId) ? e.orderId : null,
          note: UUID.test(e.orderId) ? null : e.orderId,
          instrumentId: e.instrumentId,
          account: e.account,
          action: e.action,
          side: e.side,
          qty: e.qty,
          price: e.price,
          gross: e.gross,
          fees: e.fees,
          realizedPnl: e.realizedPnl,
        };
      case "dividend":
        return { scenarioId, day, kind: e.kind, instrumentId: e.instrumentId, gross: e.gross, tax: e.tax };
      case "tax":
        return { scenarioId, day, kind: e.kind, tax: e.amount, note: e.bucket };
      case "cancel":
        return { scenarioId, day, kind: e.kind, orderId: e.orderId, note: e.reason };
      case "interest":
        return { scenarioId, day, kind: e.kind, instrumentId: e.instrumentId, gross: e.amount };
      case "dividend_adj":
        return { scenarioId, day, kind: e.kind, instrumentId: e.instrumentId, gross: e.amount };
      case "margin_call":
        return { scenarioId, day, kind: e.kind, gross: e.required, price: e.cash, note: e.level };
    }
  });
  await tx.insert(schema.ledger).values(rows);
  const filled = events.flatMap((e) => (e.kind === "trade" && UUID.test(e.orderId) ? [e.orderId] : []));
  const cancelled = events.flatMap((e) => (e.kind === "cancel" ? [e.orderId] : []));
  if (filled.length) {
    await tx
      .update(schema.orders)
      .set({ status: "filled", closedDay: day })
      .where(inArray(schema.orders.id, filled));
  }
  if (cancelled.length) {
    await tx
      .update(schema.orders)
      .set({ status: "cancelled", closedDay: day })
      .where(inArray(schema.orders.id, cancelled));
  }
}

/** steps 営業日進める。最終日に達したら自動で終了処理をする */
export async function advanceScenario(scenarioId: string, userId: string, steps: number) {
  return db.transaction(async (tx) => {
    const s = await lockScenario(tx, scenarioId, userId);
    if (s.status !== "active") throw new GameError(409, "このシナリオは終了しています");
    const toDay = Math.min(s.currentDay + steps, SCENARIO_DAYS);
    if (toDay <= s.currentDay) throw new GameError(409, "これ以上進めません");
    const cal = scenarioCalendar(s.startDate);
    const m = await loadScenarioMarket(s.id, cal, s.dataset);
    let state = await loadState(tx, s);

    // 必要なのは保有中と注文中の銘柄だけ
    const ids = new Set<number>([
      ...Object.keys(state.positions).map(Number),
      ...Object.values(state.leveraged).map((p) => p.instrumentId),
      ...state.orders.map((o) => o.instrumentId),
    ]);
    const fromDay = s.currentDay + 1;
    const series = await loadSeries(m, [...ids], fromDay, toDay);
    const days = toDayMarkets(series, toDay - fromDay + 1);
    const ctx = engineContext(m);
    const equity: { scenarioId: string; day: number; equity: number }[] = [];
    for (let i = 0; i < days.length; i++) {
      const day = fromDay + i;
      const res = advanceDay(state, days[i], ctx);
      state = res.state;
      await recordEvents(tx, s.id, day, res.events);
      equity.push({ scenarioId: s.id, day, equity: markToMarket(state, (id) => days[i].get(id)?.bar.close) });
    }
    await tx.insert(schema.equityHistory).values(equity).onConflictDoNothing();
    await saveState(tx, s, state, toDay);
    if (toDay === SCENARIO_DAYS) {
      await finishInTx(tx, { ...s, currentDay: toDay }, state, m, "finished");
    }
    return { currentDay: toDay, finished: toDay === SCENARIO_DAYS };
  });
}

/**
 * 終了処理：その日の終値で清算評価し、同じ期間（1日目〜その日）のベンチマークと比べてスコアを確定する。
 * 放棄した場合もその時点の成績で確定する。
 */
async function finishInTx(
  tx: Tx,
  s: ScenarioRow,
  state: PortfolioState,
  m: ScenarioMarket,
  status: "finished" | "abandoned",
) {
  const ctx = engineContext(m);
  const end = s.currentDay;
  let finalValue = INITIAL_CASH;
  let bench = { finalValue: INITIAL_CASH, equity: [] as number[] };
  if (end > 0) {
    const allIds = [...m.instruments.keys()];
    const series = await loadSeries(m, allIds, 1, end);
    const days = toDayMarkets(series, end);
    const lastDay = days[end - 1];
    // 保有銘柄の終値は、その銘柄の最新の足（休場なら据え置き値）を使う
    finalValue = liquidationValue(
      state,
      (id) => lastDay.get(id)?.bar.close,
      ctx,
      (id) => lastDay.get(id)?.fx ?? 1,
    );
    // ベンチマークは現物だけを均等に買い持ちする（先物は含めない）
    const spotIds = allIds.filter((id) => m.instruments.get(id)?.kind !== "future");
    bench = simulateBenchmark(spotIds, days, INITIAL_CASH, ctx);
  }
  const raw = excessReturnScore(finalValue, bench.finalValue, INITIAL_CASH);
  // ランク戦の放棄で得をしないよう、スコアは ABANDON_PENALTY_SCORE 以下にする（資産額は実際のまま残す）
  const score = status === "abandoned" && s.mode === "ranked" ? Math.min(raw, ABANDON_PENALTY_SCORE) : raw;
  await tx
    .update(schema.orders)
    .set({ status: "cancelled", closedDay: end })
    .where(and(eq(schema.orders.scenarioId, s.id), eq(schema.orders.status, "open")));
  await tx
    .update(schema.scenarios)
    .set({ status, finalValue, benchmarkValue: bench.finalValue, score, finishedAt: new Date() })
    .where(eq(schema.scenarios.id, s.id));
  for (let i = 0; i < bench.equity.length; i++) {
    await tx
      .update(schema.equityHistory)
      .set({ benchmarkEquity: bench.equity[i] })
      .where(and(eq(schema.equityHistory.scenarioId, s.id), eq(schema.equityHistory.day, i + 1)));
  }
  await tx
    .update(schema.equityHistory)
    .set({ benchmarkEquity: INITIAL_CASH })
    .where(and(eq(schema.equityHistory.scenarioId, s.id), eq(schema.equityHistory.day, 0)));
}

export async function abandonScenario(scenarioId: string, userId: string) {
  await db.transaction(async (tx) => {
    const s = await lockScenario(tx, scenarioId, userId);
    if (s.status !== "active") throw new GameError(409, "このシナリオは終了しています");
    const m = await loadScenarioMarket(s.id, scenarioCalendar(s.startDate), s.dataset);
    const state = await loadState(tx, s);
    await finishInTx(tx, s, state, m, "abandoned");
  });
}

export type PlaceOrderInput = {
  instrumentId: number;
  side: "buy" | "sell";
  type: "market" | "limit";
  /** 省略時は現物。先物の銘柄は future、信用取引は margin */
  account?: "cash" | "margin" | "future";
  /** 信用・先物の新規か返済か */
  action?: "open" | "close" | null;
  limitPrice?: number | null;
  amount?: number | null;
  fraction?: number | null;
};

export async function placeOrder(scenarioId: string, userId: string, o: PlaceOrderInput) {
  return db.transaction(async (tx) => {
    const s = await lockScenario(tx, scenarioId, userId);
    if (s.status !== "active") throw new GameError(409, "このシナリオは終了しています");
    const [member] = await tx
      .select({ kind: schema.instruments.kind })
      .from(schema.scenarioInstruments)
      .innerJoin(schema.instruments, eq(schema.instruments.id, schema.scenarioInstruments.instrumentId))
      .where(
        and(eq(schema.scenarioInstruments.scenarioId, s.id), eq(schema.scenarioInstruments.instrumentId, o.instrumentId)),
      );
    if (!member) throw new GameError(400, "このシナリオでは取引できない銘柄です");
    const account = o.account ?? "cash";
    if ((member.kind === "future") !== (account === "future")) {
      throw new GameError(400, member.kind === "future" ? "先物は先物取引で注文してください" : "先物取引はできない銘柄です");
    }
    if (o.type === "limit" && !(o.limitPrice && o.limitPrice > 0)) throw new GameError(400, "指値を入力してください");
    const hasFraction = o.fraction != null && o.fraction > 0 && o.fraction <= 1;
    const hasAmount = o.amount != null && o.amount >= 1;
    // 現物は買い＝新規、売り＝返済
    const action = account === "cash" ? (o.side === "buy" ? "open" : "close") : o.action;
    if (!action) throw new GameError(400, "新規か返済かを選んでください");

    if (action === "open") {
      if (!hasAmount) throw new GameError(400, account === "cash" ? "買付金額を入力してください" : "建玉の金額を入力してください");
      if (o.fraction) throw new GameError(400, "新規の注文は金額で指定してください");
      if (account !== "cash") {
        if (s.marginCall || s.forceClose) throw new GameError(409, "追証が出ている間は、信用・先物の新規建てはできません");
        const [opposite] = await tx
          .select({ side: schema.leveragedPositions.side })
          .from(schema.leveragedPositions)
          .where(
            and(
              eq(schema.leveragedPositions.scenarioId, s.id),
              eq(schema.leveragedPositions.account, account),
              eq(schema.leveragedPositions.instrumentId, o.instrumentId),
            ),
          );
        if (opposite && opposite.side !== (o.side === "buy" ? "long" : "short")) {
          throw new GameError(400, "反対向きの建玉があります。先に返済してください");
        }
      }
    } else {
      if (hasFraction === hasAmount) throw new GameError(400, "返済・売却は金額か割合のどちらかで指定してください");
      if (account === "cash") {
        const [pos] = await tx
          .select()
          .from(schema.positions)
          .where(and(eq(schema.positions.scenarioId, s.id), eq(schema.positions.instrumentId, o.instrumentId)));
        if (!pos) throw new GameError(400, "この銘柄は保有していません");
      } else {
        const [pos] = await tx
          .select({ side: schema.leveragedPositions.side })
          .from(schema.leveragedPositions)
          .where(
            and(
              eq(schema.leveragedPositions.scenarioId, s.id),
              eq(schema.leveragedPositions.account, account),
              eq(schema.leveragedPositions.instrumentId, o.instrumentId),
            ),
          );
        // 買い建玉の返済は売り、売り建玉の返済は買い
        if (!pos || (pos.side === "long" ? "sell" : "buy") !== o.side) {
          throw new GameError(400, "返済できる建玉がありません");
        }
      }
    }
    const [row] = await tx
      .insert(schema.orders)
      .values({
        scenarioId: s.id,
        instrumentId: o.instrumentId,
        side: o.side,
        account,
        action: account === "cash" ? null : action,
        type: o.type,
        limitPrice: o.type === "limit" ? o.limitPrice! : null,
        amount: o.amount ?? null,
        fraction: action === "close" ? (o.fraction ?? null) : null,
        placedDay: s.currentDay,
      })
      .returning({ id: schema.orders.id });
    return row.id;
  });
}

export async function cancelOrder(scenarioId: string, userId: string, orderId: string) {
  await db.transaction(async (tx) => {
    const s = await lockScenario(tx, scenarioId, userId);
    const res = await tx
      .update(schema.orders)
      .set({ status: "cancelled", closedDay: s.currentDay })
      .where(and(eq(schema.orders.id, orderId), eq(schema.orders.scenarioId, s.id), eq(schema.orders.status, "open")))
      .returning({ id: schema.orders.id });
    if (res.length === 0) throw new GameError(404, "取り消せる注文がありません");
  });
}

/**
 * 実日付・実価格を出してよいか。実データのランク戦は終了まで出さず、練習モードで表示を選んだ場合と終了後は出す。
 * 架空データには意味のある実日付がないので、終了後も出さない（代わりに架空暦の年を出す）
 */
export function isRevealed(s: Pick<ScenarioRow, "mode" | "showReal" | "status" | "dataset">): boolean {
  if (s.dataset === "synthetic") return false;
  return s.status !== "active" || (s.mode === "practice" && s.showReal);
}

