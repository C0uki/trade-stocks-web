import {
  ABANDON_PENALTY_SCORE,
  COSTS,
  FUTURE_COSTS,
  FUTURE_MARGIN,
  FUTURE_SECTORS,
  FX_FEE,
  INITIAL_CASH,
  MARGIN_CARRY,
  MARGIN_TRADING_RATE,
  MIN_SCENARIOS_FOR_RANKING,
  SCENARIO_DAYS,
  TAX_RATE,
} from "@/config/game";
import { EMERGENCY_MARGIN_LEVEL } from "@/lib/engine/engine";
import { yen } from "@/lib/format";
import { ja } from "@/lib/i18n/ja";

const p = (n: number) =>
  n < 0.01 ? `${Number((n * 100).toPrecision(2))}%` : `${(n * 100).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}%`;

export default function RulesPage() {
  const r = ja.rules;
  return (
    <article className="panel mx-auto max-w-3xl space-y-6 p-6 text-sm leading-relaxed">
      <h1 className="text-xl font-bold">{r.title}</h1>
      {r.sections({
        initialCash: yen(INITIAL_CASH),
        days: SCENARIO_DAYS,
        tax: p(TAX_RATE),
        minRanked: MIN_SCENARIOS_FOR_RANKING,
        penalty: ABANDON_PENALTY_SCORE,
        stockMargin: p(MARGIN_TRADING_RATE.stock),
        cryptoMargin: p(MARGIN_TRADING_RATE.crypto),
        carryLong: p(MARGIN_CARRY.long),
        carryShort: p(MARGIN_CARRY.short),
        emergency: p(EMERGENCY_MARGIN_LEVEL),
      }).map((s) => (
        <section key={s.heading}>
          <h2 className="mb-1.5 text-base font-semibold">{s.heading}</h2>
          <ul className="list-disc space-y-1 pl-5">
            {s.items.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </section>
      ))}
      <section>
        <h2 className="mb-1.5 text-base font-semibold">{r.costsHeading}</h2>
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th>{r.costCols.market}</th>
                <th className="num">{r.costCols.commission}</th>
                <th className="num">{r.costCols.spread}</th>
                <th className="num">{r.costCols.fx}</th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(COSTS) as (keyof typeof COSTS)[]).map((k) => (
                <tr key={k}>
                  <td>{ja.market[k]}</td>
                  <td className="num">{p(COSTS[k].commission)}</td>
                  <td className="num">{p(COSTS[k].spread)}</td>
                  <td className="num">{k === "JP" || k === "CRYPTO" ? "—" : p(FX_FEE)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <h2 className="mb-1.5 text-base font-semibold">{r.futuresHeading}</h2>
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th>{r.futuresCols.sector}</th>
                <th className="num">{r.costCols.commission}</th>
                <th className="num">{r.costCols.spread}</th>
                <th className="num">{r.futuresCols.margin}</th>
              </tr>
            </thead>
            <tbody>
              {FUTURE_SECTORS.map((k) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td className="num">{p(FUTURE_COSTS[k].commission)}</td>
                  <td className="num">{p(FUTURE_COSTS[k].spread)}</td>
                  <td className="num">{p(FUTURE_MARGIN[k])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <p className="text-xs text-muted">{r.dataNote}</p>
    </article>
  );
}
