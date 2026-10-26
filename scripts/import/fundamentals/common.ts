import type { IsoDate } from "../../../src/lib/engine/calendar";

/** 通期決算1件。値は報告時点の1株あたり（株式分割の補正前） */
export type AnnualReport = { periodEnd: IsoDate; reportDate: IsoDate; eps: number | null; bps: number | null };

export type Split = { date: IsoDate; numerator: number; denominator: number };

/**
 * 株価（Yahoo）は過去の株式分割を全部補正済みなので、1株あたりの値も同じ基準に直す。
 * 決算書は提出日より前の分割を反映済みなので、提出日より後の分割だけで割る
 */
export function splitFactorAfter(splits: readonly Split[], date: IsoDate): number {
  return splits.filter((s) => s.date > date).reduce((f, s) => f * (s.numerator / s.denominator), 1);
}

/**
 * 同じ提出日に複数の決算期が載っている（前期の比較数値など）ときは、いちばん新しい期だけを残し、
 * 提出日の昇順に並べる
 */
export function latestPerReportDate(reports: readonly AnnualReport[]): AnnualReport[] {
  const by = new Map<IsoDate, AnnualReport>();
  for (const r of reports) {
    const cur = by.get(r.reportDate);
    if (!cur || r.periodEnd > cur.periodEnd) by.set(r.reportDate, r);
  }
  return [...by.values()].sort((a, b) => a.reportDate.localeCompare(b.reportDate));
}

/**
 * 明らかにおかしい値（単位の違い、種類株ごとの1株の違いなど）を外す。
 * 提出日の株価で PER・PBR を出し、ありえない範囲なら null にする
 */
export function sanitize(r: { eps: number | null; bps: number | null }, price: number | undefined) {
  if (!price || price <= 0) return r;
  const per = r.eps && r.eps > 0 ? price / r.eps : null;
  const pbr = r.bps && r.bps > 0 ? price / r.bps : null;
  return {
    eps: per !== null && (per < 1.5 || per > 1000) ? null : r.eps,
    bps: r.bps !== null && (r.bps <= 0 || (pbr !== null && (pbr < 0.05 || pbr > 200))) ? null : r.bps,
  };
}
