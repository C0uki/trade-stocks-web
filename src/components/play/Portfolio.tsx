"use client";

import { useState } from "react";
import { api } from "@/lib/client";
import { dayLabel, indexPrice, qty, signedYen, tone, yen } from "@/lib/format";
import type { ScenarioView } from "@/lib/game/views";
import { ja } from "@/lib/i18n/ja";

const c = ja.play.cols;

type Props = {
  view: ScenarioView;
  onSelect: (id: number) => void;
  onChanged: () => void;
};

export function Portfolio({ view, onSelect, onChanged }: Props) {
  const [tab, setTab] = useState<"positions" | "orders" | "history">("positions");
  return (
    <div>
      <div className="flex gap-1" role="tablist">
        {(
          [
            ["positions", `${ja.play.positions}（${view.positions.length + view.leveraged.length}）`],
            ["orders", `${ja.play.orders}（${view.orders.length}）`],
            ["history", ja.play.history],
          ] as const
        ).map(([k, label]) => (
          <button key={k} role="tab" className="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="mt-2 overflow-x-auto">
        {tab === "positions" && (
          <>
            <Positions view={view} onSelect={onSelect} />
            <Leveraged view={view} onSelect={onSelect} />
          </>
        )}
        {tab === "orders" && <Orders view={view} onChanged={onChanged} />}
        {tab === "history" && <History view={view} />}
      </div>
    </div>
  );
}

function Positions({ view, onSelect }: { view: ScenarioView; onSelect: (id: number) => void }) {
  if (view.positions.length === 0) {
    return view.leveraged.length === 0 ? <p className="p-2 text-sm text-muted">{ja.play.noPositions}</p> : null;
  }
  return (
    <table className="data" data-testid="positions">
      <thead>
        <tr>
          <th>{c.instrument}</th>
          <th className="num">{c.qty}</th>
          <th className="num">{c.avgCost}</th>
          <th className="num">{c.price}</th>
          <th className="num">{c.value}</th>
          <th className="num">{c.pnl}</th>
          {view.revealed && <th className="num">{ja.info.realPrice}</th>}
        </tr>
      </thead>
      <tbody>
        {view.positions.map((p) => (
          <tr key={p.instrumentId} className="cursor-pointer hover:bg-panel-2" onClick={() => onSelect(p.instrumentId)}>
            <td>
              {p.name} <span className="text-xs text-muted">{p.symbol}</span>
            </td>
            <td className="num">{qty(p.qty)}</td>
            <td className="num">{indexPrice(p.avgCost)}</td>
            <td className="num">{indexPrice(p.price)}</td>
            <td className="num">{yen(p.value)}</td>
            <td className={`num ${tone(p.pnl)}`}>{signedYen(p.pnl)}</td>
            {view.revealed && <td className="num">{p.realPrice ?? "—"}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Leveraged({ view, onSelect }: { view: ScenarioView; onSelect: (id: number) => void }) {
  if (view.leveraged.length === 0) return null;
  return (
    <div className="mt-3">
      <h3 className="mb-1 text-sm font-semibold">{ja.play.leveraged}</h3>
      <table className="data" data-testid="leveraged">
        <thead>
          <tr>
            <th>{c.instrument}</th>
            <th>{c.account}</th>
            <th className="num">{c.entry}</th>
            <th className="num">{c.price}</th>
            <th className="num">{c.notional}</th>
            <th className="num">{c.margin}</th>
            <th className="num">{c.pnl}</th>
            {view.revealed && <th className="num">{ja.info.realPrice}</th>}
          </tr>
        </thead>
        <tbody>
          {view.leveraged.map((p) => (
            <tr
              key={`${p.account}:${p.instrumentId}`}
              className="cursor-pointer hover:bg-panel-2"
              onClick={() => onSelect(p.instrumentId)}
            >
              <td>
                {p.name} <span className="text-xs text-muted">{p.symbol}</span>
              </td>
              <td className={p.side === "long" ? "text-up" : "text-down"}>
                {ja.order.accounts[p.account]}
                {p.side === "long" ? ja.order.buy : ja.order.sell}
              </td>
              <td className="num">{indexPrice(p.entryPrice)}</td>
              <td className="num">{indexPrice(p.price)}</td>
              <td className="num">{yen(p.value)}</td>
              <td className="num">{yen(p.margin)}</td>
              <td className={`num ${tone(p.pnl)}`}>{signedYen(p.pnl)}</td>
              {view.revealed && <td className="num">{p.realPrice ?? "—"}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function orderLabel(o: { account: string; action: string | null; side: "buy" | "sell" }): string {
  if (o.account === "cash") return o.side === "buy" ? ja.order.buy : ja.order.sell;
  const a = ja.order.accounts[o.account];
  return o.action === "close" ? ja.ledger.close(a, o.side) : ja.ledger.open(a, o.side);
}

function Orders({ view, onChanged }: { view: ScenarioView; onChanged: () => void }) {
  if (view.orders.length === 0) return <p className="p-2 text-sm text-muted">{ja.play.noOrders}</p>;
  return (
    <table className="data" data-testid="orders">
      <thead>
        <tr>
          <th>{c.instrument}</th>
          <th>{c.side}</th>
          <th>{c.type}</th>
          <th className="num">{c.size}</th>
          <th>{c.placed}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {view.orders.map((o) => (
          <tr key={o.id}>
            <td>{o.name}</td>
            <td className={o.side === "buy" ? "text-up" : "text-down"}>{orderLabel(o)}</td>
            <td>{o.type === "market" ? ja.order.market : `${ja.order.limit} ${indexPrice(o.limitPrice)}`}</td>
            <td className="num">{o.fraction ? `${o.fraction * 100}%` : yen(o.amount)}</td>
            <td className="text-muted">{dayLabel(o.placedDay)}</td>
            <td>
              <button
                className="text-sm text-down hover:underline"
                onClick={async () => {
                  await api(`/api/scenarios/${view.id}/orders/${o.id}`, { method: "DELETE" });
                  onChanged();
                }}
              >
                {ja.play.cancel}
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type LedgerRow = ScenarioView["ledger"][number];

function ledgerCells(l: LedgerRow): { label: string; amount: number | null; cost: number | null; showPrice: boolean } {
  switch (l.kind) {
    case "trade": {
      const side = l.side === "sell" ? "sell" : "buy";
      let label = orderLabel({ account: l.account ?? "cash", action: l.action, side });
      if (l.account === "cash" || l.account == null) label = side === "buy" ? ja.ledger.buy : ja.ledger.sell;
      if (l.note === "forced") label = `${ja.ledger.forced}（${label}）`;
      if (l.note === "cover") label = `${ja.ledger.cover}（${label}）`;
      return { label, amount: l.gross, cost: l.fees, showPrice: true };
    }
    case "dividend":
      return { label: ja.ledger.dividend, amount: l.gross, cost: l.tax, showPrice: false };
    case "tax": {
      const future = l.note === "future";
      const refund = (l.tax ?? 0) < 0;
      const label = future ? (refund ? ja.ledger.futuresRefund : ja.ledger.futuresTax) : refund ? ja.ledger.refund : ja.ledger.tax;
      return { label, amount: null, cost: l.tax, showPrice: false };
    }
    case "cancel":
      return {
        label: `${ja.ledger.cancel}（${ja.ledger.cancelReason[l.note ?? ""] ?? ""}）`,
        amount: null,
        cost: null,
        showPrice: false,
      };
    case "interest":
      return { label: ja.ledger.interest, amount: null, cost: l.gross, showPrice: false };
    case "dividend_adj":
      return { label: ja.ledger.dividendAdj, amount: l.gross, cost: null, showPrice: false };
    case "margin_call":
      return { label: ja.ledger.marginCall[l.note ?? ""] ?? l.kind, amount: l.gross, cost: null, showPrice: false };
    default:
      return { label: l.kind, amount: l.gross, cost: l.fees, showPrice: true };
  }
}

export function History({ view }: { view: ScenarioView }) {
  if (view.ledger.length === 0) return <p className="p-2 text-sm text-muted">{ja.play.noHistory}</p>;
  return (
    <table className="data" data-testid="history">
      <thead>
        <tr>
          <th>{c.day}</th>
          <th>{c.what}</th>
          <th>{c.instrument}</th>
          <th className="num">{c.unit}</th>
          {view.revealed && <th className="num">{ja.info.realPrice}</th>}
          <th className="num">{c.amount}</th>
          <th className="num">{c.costs}</th>
          <th className="num">{c.realized}</th>
        </tr>
      </thead>
      <tbody>
        {view.ledger.map((l) => {
          const { label, amount, cost, showPrice } = ledgerCells(l);
          return (
            <tr key={l.id}>
              <td className="text-muted">
                {dayLabel(l.day)}
                {l.date && <span className="ml-1 text-xs">{l.date}</span>}
              </td>
              <td>{label}</td>
              <td>{l.name}</td>
              <td className="num">{showPrice && l.price != null ? indexPrice(l.price) : ""}</td>
              {view.revealed && <td className="num">{showPrice ? (l.realPrice ?? "") : ""}</td>}
              <td className="num">{amount != null ? yen(amount) : ""}</td>
              <td className="num">{cost != null ? yen(cost) : ""}</td>
              <td className={`num ${tone(l.realizedPnl)}`}>
                {l.kind === "trade" && (l.action === "close" || l.side === "sell") ? signedYen(l.realizedPnl) : ""}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
