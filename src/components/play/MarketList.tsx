"use client";

import { useMemo, useState } from "react";
import { indexPrice, pct, tone } from "@/lib/format";
import type { MarketRow } from "@/lib/game/views";
import { ja } from "@/lib/i18n/ja";

type Props = {
  rows: MarketRow[];
  held: Set<number>;
  selected: number | null;
  onSelect: (id: number) => void;
};

const FILTERS = ["ALL", "HELD", "JP", "US", "EU", "CRYPTO", "FUTURE"] as const;

export function MarketList({ rows, held, selected, onSelect }: Props) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("ALL");
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const query = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "HELD" && !held.has(r.id)) return false;
      if (filter === "FUTURE" && r.kind !== "future") return false;
      // 市場の絞り込みは現物だけ（先物は「先物」で見る）
      if (filter !== "ALL" && filter !== "HELD" && filter !== "FUTURE" && (r.market !== filter || r.kind === "future")) {
        return false;
      }
      if (query && !r.name.toLowerCase().includes(query) && !r.symbol.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [rows, held, filter, q]);

  return (
    <div className="flex h-full flex-col">
      <input className="input" placeholder={ja.play.search} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="mt-2 flex flex-wrap gap-1">
        {FILTERS.map((f) => (
          <button key={f} className="tab" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f === "ALL" ? ja.play.all : f === "HELD" ? ja.play.holdingsOnly : f === "FUTURE" ? ja.play.futures : ja.market[f]}
          </button>
        ))}
      </div>
      <ul className="mt-2 max-h-[300px] overflow-y-auto lg:max-h-[calc(100vh-260px)]" data-testid="market-list">
        {shown.map((r) => (
          <li key={r.id}>
            <button
              onClick={() => onSelect(r.id)}
              className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-panel-2 ${
                selected === r.id ? "bg-panel-2" : ""
              }`}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  {held.has(r.id) && <span className="mr-1 text-accent">●</span>}
                  {r.name}
                </span>
                <span className="text-xs text-muted">
                  {r.symbol} · {r.kind === "future" ? ja.kind.future : ja.market[r.market]}
                  {r.sector && r.sector !== ja.market[r.market] ? ` · ${r.sector}` : ""}
                  {!r.tradable && <span className="ml-1 text-down">{ja.play.closed}</span>}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block">{indexPrice(r.price)}</span>
                <span className={`text-xs ${tone(r.change)}`}>{pct(r.change)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
