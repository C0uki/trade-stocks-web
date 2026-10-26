"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ABANDON_PENALTY_SCORE } from "@/config/game";
import { api } from "@/lib/client";
import { pct, rate, ratio, tone, yen } from "@/lib/format";
import type { InstrumentView, MarketRow, ScenarioView } from "@/lib/game/views";
import { ja } from "@/lib/i18n/ja";
import { MarketList } from "./MarketList";
import { OrderForm } from "./OrderForm";
import { Portfolio } from "./Portfolio";
import { PriceChart } from "./PriceChart";

type Props = { id: string; initial: ScenarioView; initialMarket: MarketRow[] };

export function PlayClient({ id, initial, initialMarket }: Props) {
  const router = useRouter();
  const [view, setView] = useState<ScenarioView>(initial);
  const [market, setMarket] = useState<MarketRow[]>(initialMarket);
  const [selected, setSelected] = useState<number | null>(
    () =>
      initial.positions[0]?.instrumentId ?? initialMarket.find((r) => r.kind === "etf")?.id ?? initialMarket[0]?.id ?? null,
  );
  const [detail, setDetail] = useState<InstrumentView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [v, m] = await Promise.all([
      api<ScenarioView>(`/api/scenarios/${id}`),
      api<MarketRow[]>(`/api/scenarios/${id}/market`),
    ]);
    setView(v);
    setMarket(m);
  }, [id]);

  useEffect(() => {
    if (selected == null) return;
    let cancelled = false;
    api<InstrumentView>(`/api/scenarios/${id}/instruments/${selected}`)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [id, selected, view.currentDay]);

  const held = useMemo(
    () => new Set([...view.positions.map((p) => p.instrumentId), ...view.leveraged.map((p) => p.instrumentId)]),
    [view.positions, view.leveraged],
  );
  const active = view.status === "active";

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const advance = (steps: number) =>
    act(async () => {
      const r = await api<{ finished: boolean }>(`/api/scenarios/${id}/advance`, { body: { steps } });
      if (r.finished) router.push(`/result/${id}`);
    });

  const ret = view.equity / view.initialCash - 1;

  return (
    <div className="space-y-4">
      <section className="panel flex flex-wrap items-center gap-x-6 gap-y-3 p-4">
        <div>
          <div className="text-xs text-muted">
            {view.mode === "ranked" ? ja.scenario.ranked : ja.scenario.practice} ·{" "}
            <span className={view.dataset === "real" ? "font-semibold text-accent" : ""} data-testid="dataset">
              {ja.dataset[view.dataset]}
            </span>
            {view.currentDate && ` · ${view.currentDate}`}
          </div>
          <div className="text-lg font-bold" data-testid="day">
            {ja.play.day(view.currentDay, view.totalDays)}
          </div>
          <div className="mt-1 h-1.5 w-40 rounded bg-panel-2">
            <div className="h-1.5 rounded bg-accent" style={{ width: `${(view.currentDay / view.totalDays) * 100}%` }} />
          </div>
        </div>
        <Stat label={ja.play.equity} value={yen(view.equity)} testId="equity" />
        <Stat label={ja.play.returnRate} value={pct(ret)} className={tone(ret)} />
        <Stat label={ja.play.cash} value={yen(view.cash)} testId="cash" />
        <Stat label={ja.play.taxPaid} value={yen(view.tax.paid + view.futuresTax.paid)} />
        {view.margin.level != null && (
          <>
            <Stat label={ja.play.requiredMargin} value={yen(view.margin.required)} testId="required-margin" />
            <Stat
              label={ja.play.marginLevel}
              value={rate(view.margin.level, 0)}
              className={view.margin.level < 1 ? "text-down" : ""}
              testId="margin-level"
            />
          </>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          {active ? (
            <>
              <button className="btn btn-primary" disabled={busy} onClick={() => advance(1)} data-testid="next1">
                {ja.play.next1}
              </button>
              <button className="btn" disabled={busy} onClick={() => advance(5)} data-testid="next5">
                {ja.play.next5}
              </button>
              <button
                className="btn btn-danger"
                disabled={busy}
                onClick={() => {
                  if (!confirm(ja.play.abandonConfirm(view.mode, ABANDON_PENALTY_SCORE))) return;
                  act(async () => {
                    await api(`/api/scenarios/${id}/abandon`, { method: "POST" });
                    router.push(`/result/${id}`);
                  });
                }}
              >
                {ja.play.abandon}
              </button>
            </>
          ) : (
            <Link href={`/result/${id}`} className="btn btn-primary">
              {ja.play.toResult}
            </Link>
          )}
        </div>
        {error && <p className="w-full text-sm text-down">{error}</p>}
        {active && (view.margin.call || view.margin.forceClose) && (
          <p
            className="w-full rounded-md px-3 py-2 text-sm font-medium text-white"
            style={{ background: "var(--down)" }}
            role="alert"
            data-testid="margin-call"
          >
            {view.margin.forceClose
              ? ja.play.forceClose
              : ja.play.marginCall(yen(view.margin.required), yen(view.cash))}
          </p>
        )}
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_minmax(0,1fr)_300px]">
        <section className="panel p-3">
          <h2 className="mb-2 text-sm font-semibold">
            {ja.play.markets}（{market.length}）
          </h2>
          <MarketList rows={market} held={held} selected={selected} onSelect={setSelected} />
        </section>

        <section className="panel min-w-0 p-4">
          {detail ? (
            <>
              <div className="flex flex-wrap items-baseline gap-x-3">
                <h2 className="text-lg font-bold" data-testid="instrument-name">
                  {detail.name}
                </h2>
                <span className="text-sm text-muted">
                  {[detail.symbol, ja.market[detail.market], ja.kind[detail.kind], detail.sector]
                    .filter((v, i, a) => v && a.indexOf(v) === i)
                    .join(" · ")}
                </span>
              </div>
              <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm">
                {detail.kind !== "future" && (
                  <>
                    <Info label={ja.info.dividendYield} value={rate(detail.fundamentals.dividendYield)} />
                    <Info label={ja.info.per} value={ratio(detail.fundamentals.per)} />
                    <Info label={ja.info.pbr} value={ratio(detail.fundamentals.pbr, 2)} />
                  </>
                )}
                {detail.marginRate < 1 && (
                  <Info label={ja.info.marginRate} value={rate(detail.marginRate, 0)} />
                )}
                {detail.real && <Info label={ja.info.realPrice} value={detail.real.close} />}
              </dl>
              <p className="mt-1 text-xs text-muted">
                {detail.kind === "future" && detail.currency !== "JPY" ? ja.play.chartHintFuture : ja.play.chartHint}
              </p>
              <div className="mt-3">
                <PriceChart bars={detail.bars} />
              </div>
            </>
          ) : (
            <p className="text-sm text-muted">{selected == null ? ja.play.selectInstrument : ja.common.loading}</p>
          )}
        </section>

        <section className="panel p-4">
          <h2 className="mb-3 text-sm font-semibold">{ja.order.title}</h2>
          {detail ? (
            <OrderForm
              key={detail.id}
              scenarioId={id}
              instrument={detail}
              view={view}
              disabled={!active || busy}
              onPlaced={refresh}
            />
          ) : null}
        </section>
      </div>

      <section className="panel p-4">
        <Portfolio view={view} onSelect={setSelected} onChanged={refresh} />
      </section>
    </div>
  );
}

function Stat({ label, value, className = "", testId }: { label: string; value: string; className?: string; testId?: string }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className={`font-semibold ${className}`} data-testid={testId}>
        {value}
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-muted">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
