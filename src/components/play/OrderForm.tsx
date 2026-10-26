"use client";

import { useState } from "react";
import { MARGIN_CARRY } from "@/config/game";
import { api } from "@/lib/client";
import { indexPrice, qty, rate, yen } from "@/lib/format";
import type { InstrumentView, ScenarioView } from "@/lib/game/views";
import { ja } from "@/lib/i18n/ja";

type Props = {
  scenarioId: string;
  instrument: InstrumentView;
  view: ScenarioView;
  disabled: boolean;
  onPlaced: () => void;
};

const FRACTIONS = [0.25, 0.5, 1] as const;

type Account = "cash" | "margin" | "future";
/** 現物は buy / sell、信用・先物は新規買い・新規売り・返済 */
type Mode = "buy" | "sell" | "openLong" | "openShort" | "close";

export function OrderForm({ scenarioId, instrument, view, disabled, onPlaced }: Props) {
  const isFuture = instrument.kind === "future";
  const [account, setAccount] = useState<Account>(isFuture ? "future" : "cash");
  const [mode, setMode] = useState<Mode>(isFuture ? "openLong" : "buy");
  const [type, setType] = useState<"market" | "limit">("market");
  const [amount, setAmount] = useState("1000000");
  const [closeBy, setCloseBy] = useState<"fraction" | "amount">("fraction");
  const [fraction, setFraction] = useState<number>(1);
  const [limit, setLimit] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const last = instrument.bars[instrument.bars.length - 1];
  const c = instrument.costs;

  const position = view.positions.find((p) => p.instrumentId === instrument.id);
  const leveraged = view.leveraged.find((p) => p.instrumentId === instrument.id && p.account === account);
  const isOpen = mode === "buy" || mode === "openLong" || mode === "openShort";
  // 売買の向き：返済は建玉と反対
  const side: "buy" | "sell" =
    mode === "buy" || mode === "openLong" ? "buy" : mode === "close" ? (leveraged?.side === "short" ? "buy" : "sell") : "sell";

  function switchAccount(a: Account) {
    setAccount(a);
    setMode(a === "cash" ? "buy" : "openLong");
  }

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      await api(`/api/scenarios/${scenarioId}/orders`, {
        body: {
          instrumentId: instrument.id,
          side,
          account,
          action: account === "cash" ? null : isOpen ? "open" : "close",
          type,
          limitPrice: type === "limit" ? Number(limit) : null,
          amount: isOpen || closeBy === "amount" ? Number(amount) : null,
          fraction: !isOpen && closeBy === "fraction" ? fraction : null,
        },
      });
      setMsg({ ok: true, text: ja.order.placed });
      onPlaced();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const modes: { key: Mode; label: string; color: string }[] =
    account === "cash"
      ? [
          { key: "buy", label: ja.order.buy, color: "var(--up)" },
          { key: "sell", label: ja.order.sell, color: "var(--down)" },
        ]
      : [
          { key: "openLong", label: ja.order.openLong, color: "var(--up)" },
          { key: "openShort", label: ja.order.openShort, color: "var(--down)" },
          { key: "close", label: ja.order.close, color: "var(--accent)" },
        ];
  const nothingToClose = !isOpen && (account === "cash" ? !position : !leveraged);
  // 反対向きの建玉があるときは新規建てできない（両建てなし）
  const opposite =
    leveraged && ((mode === "openLong" && leveraged.side === "short") || (mode === "openShort" && leveraged.side === "long"));
  const blockedByCall = account !== "cash" && isOpen && (view.margin.call || view.margin.forceClose);

  const n = Number(amount) || 0;
  const required = n * instrument.marginRate;
  const fees = n * (c.commission + c.fxFee);
  const levelAfter =
    view.margin.required + required > 0 ? (view.cash - fees) / (view.margin.required + required) : null;

  return (
    <div className="space-y-3">
      {!isFuture && (
        <div className="flex gap-1" role="tablist" aria-label={ja.play.cols.account}>
          {(["cash", "margin"] as const).map((a) => (
            <button key={a} role="tab" className="tab" aria-selected={account === a} onClick={() => switchAccount(a)}>
              {ja.order.accounts[a]}
            </button>
          ))}
        </div>
      )}
      <div className={`grid gap-2 ${modes.length === 2 ? "grid-cols-2" : "grid-cols-3"}`}>
        {modes.map((m) => (
          <button
            key={m.key}
            className={`btn whitespace-nowrap ${modes.length === 3 ? "px-1 text-sm" : ""}`}
            aria-pressed={mode === m.key}
            style={mode === m.key ? { background: m.color, color: "#fff", borderColor: "transparent" } : undefined}
            onClick={() => setMode(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="flex gap-1" role="tablist">
        {(["market", "limit"] as const).map((t) => (
          <button key={t} role="tab" className="tab" aria-selected={type === t} onClick={() => setType(t)}>
            {t === "market" ? ja.order.market : ja.order.limit}
          </button>
        ))}
      </div>

      {type === "limit" && (
        <label className="block text-sm text-muted">
          {ja.order.limitPrice}
          <input
            className="input mt-1"
            inputMode="decimal"
            placeholder={last ? indexPrice(last.close) : ""}
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
          />
        </label>
      )}

      {account !== "cash" && leveraged && (
        <p className="text-sm text-muted">{ja.order.leveragedHolding(leveraged.side, yen(leveraged.value))}</p>
      )}

      {isOpen ? (
        <label className="block text-sm text-muted">
          {account === "cash" ? ja.order.amount : ja.order.notional}
          <input className="input mt-1" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <div className="mt-1 flex flex-wrap gap-1">
            {[100_000, 1_000_000, 3_000_000, ...(account === "cash" ? [] : [10_000_000])].map((v) => (
              <button key={v} className="tab" onClick={() => setAmount(String(v))}>
                {yen(v)}
              </button>
            ))}
            {account === "cash" && (
              <button className="tab" onClick={() => setAmount(String(Math.max(0, Math.floor(view.margin.free))))}>
                {ja.order.allCash}
              </button>
            )}
          </div>
        </label>
      ) : nothingToClose ? (
        <p className="text-sm text-muted">{account === "cash" ? ja.order.notHeld : ja.order.noLeveraged}</p>
      ) : (
        <div className="space-y-2 text-sm">
          {account === "cash" && position && (
            <div className="text-muted">{ja.order.holding(qty(position.qty), yen(position.value))}</div>
          )}
          <div className="flex gap-1">
            {(["fraction", "amount"] as const).map((b) => (
              <button key={b} className="tab" aria-pressed={closeBy === b} onClick={() => setCloseBy(b)}>
                {b === "fraction" ? (account === "cash" ? ja.order.byFraction : ja.order.byPosition) : ja.order.byAmount}
              </button>
            ))}
          </div>
          {closeBy === "fraction" ? (
            <div className="flex gap-1">
              {FRACTIONS.map((f) => (
                <button key={f} className="tab" aria-pressed={fraction === f} onClick={() => setFraction(f)}>
                  {f === 1 ? ja.order.all : `${f * 100}%`}
                </button>
              ))}
            </div>
          ) : (
            <input className="input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
          )}
        </div>
      )}

      {account !== "cash" && isOpen && (
        <div className="space-y-0.5 text-xs text-muted" data-testid="margin-preview">
          <p>{ja.order.requiredFor(rate(instrument.marginRate, 0), yen(required))}</p>
          <p>{ja.order.levelAfter(levelAfter == null ? "—" : rate(levelAfter, 0))}</p>
          <p>{ja.order.freeCash(yen(view.margin.free))}</p>
        </div>
      )}

      <button
        className="btn btn-primary w-full"
        disabled={disabled || busy || nothingToClose || !!opposite || blockedByCall}
        onClick={submit}
        data-testid="submit-order"
      >
        {account === "cash" ? ja.order.submit(side) : ja.order.submitLeveraged(mode as "openLong" | "openShort" | "close")}
      </button>
      {msg && <p className={`text-sm ${msg.ok ? "text-up" : "text-down"}`}>{msg.text}</p>}
      <p className="text-xs text-muted">{ja.order.note}</p>
      {account !== "cash" && <p className="text-xs text-muted">{ja.order.marginNote}</p>}
      {!instrument.tradableToday && <p className="text-xs text-down">{ja.order.closedToday}</p>}
      <p className="text-xs text-muted">{ja.order.costs(c.commission, c.spread, c.fxFee)}</p>
      {account === "margin" && (
        <p className="text-xs text-muted">{ja.order.carryNote(rate(MARGIN_CARRY.long, 1), rate(MARGIN_CARRY.short, 1))}</p>
      )}
    </div>
  );
}
