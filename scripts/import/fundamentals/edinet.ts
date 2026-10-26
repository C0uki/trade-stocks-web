import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import iconv from "iconv-lite";
import { addDays, toIso, type IsoDate } from "../../../src/lib/engine/calendar";
import type { AnnualReport } from "./common";

/**
 * EDINET（金融庁）の有価証券報告書から、通期の1株当たり当期純利益（EPS）と1株当たり純資産（BPS）を取り出す。
 * 書類は XBRL を CSV にしたもの（type=5）を使い、「主要な経営指標等の推移」の当期の値を読む。
 * API で取れるのは直近10年分の書類だけ。
 */

const API = "https://api.edinet-fsa.go.jp/api/v2";
const CODE_LIST = "https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip";
/** 有価証券報告書 */
const ANNUAL_REPORT = "120";

const EPS = /^jpcrp_cor:BasicEarningsLossPerShare(IFRS|USGAAP|JMIS)?SummaryOfBusinessResults$/;
const BPS =
  /^jpcrp_cor:(NetAssetsPerShare|EquityAttributableToOwnersOfParentPerShare(IFRS|USGAAP|JMIS)?|ShareholdersEquityPerShareUSGAAP)SummaryOfBusinessResults$/;

/**
 * XBRL の CSV（タブ区切り）から当期の EPS・BPS を読む。連結があれば連結、なければ個別の値を使う
 * 列：要素ID, 項目名, コンテキストID, 相対年度, 連結・個別, 期間・時点, ユニットID, 単位, 値
 */
export function perShareFromXbrlCsv(tsv: string): { eps: number | null; bps: number | null } {
  const found: Record<string, number> = {};
  for (const line of tsv.split(/\r?\n/).slice(1)) {
    const cols = line.split("\t").map((c) => c.replace(/^"|"$/g, ""));
    const [id, , context, , , , , , value] = cols;
    if (!id || !context) continue;
    const kind = EPS.test(id) ? "eps" : BPS.test(id) ? "bps" : null;
    if (!kind) continue;
    const consolidated = context === "CurrentYearDuration" || context === "CurrentYearInstant";
    const standalone =
      context === "CurrentYearDuration_NonConsolidatedMember" || context === "CurrentYearInstant_NonConsolidatedMember";
    if (!consolidated && !standalone) continue;
    const v = Number(value?.replace(/,/g, ""));
    if (!Number.isFinite(v) || value === "") continue;
    const key = `${kind}:${consolidated ? "c" : "s"}`;
    if (!(key in found)) found[key] = v;
  }
  return { eps: found["eps:c"] ?? found["eps:s"] ?? null, bps: found["bps:c"] ?? found["bps:s"] ?? null };
}

type DocMeta = { docID: string; edinetCode: string | null; docTypeCode: string | null; submitDateTime: string; periodEnd: string | null; withdrawalStatus: string; csvFlag: string };

export class EdinetClient {
  private codes: Map<string, string> | null = null;
  private docs: Map<string, DocMeta[]> | null = null;

  constructor(
    private readonly key: string,
    /** 書類一覧の日ごとのキャッシュ（API を何度も叩かないため） */
    private readonly cacheDir: string,
    private readonly from: IsoDate = addDays(toIso(Date.now()), -3650),
  ) {}

  /** 証券コード（4桁）→ EDINET コード */
  private async edinetCode(secCode: string): Promise<string | null> {
    if (!this.codes) {
      const zip = unzipSync(new Uint8Array(await (await fetch(CODE_LIST)).arrayBuffer()));
      const csv = iconv.decode(Buffer.from(Object.values(zip)[0]), "cp932");
      this.codes = new Map();
      for (const line of csv.split(/\r?\n/).slice(2)) {
        const c = line.split(",").map((x) => x.replace(/^"|"$/g, ""));
        // 証券コードは5桁（末尾は0）
        if (c[11]) this.codes.set(c[11].slice(0, 4), c[0]);
      }
    }
    return this.codes.get(secCode) ?? null;
  }

  private async get(url: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}Subscription-Key=${this.key}`);
      if (res.ok) return res;
      if (attempt >= 3 || res.status === 401 || res.status === 404) throw new Error(`EDINET ${res.status}`);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }

  /** 対象期間の有価証券報告書の一覧を、EDINET コードごとにまとめる（日ごとの一覧はキャッシュする） */
  private async annualReportDocs(): Promise<Map<string, DocMeta[]>> {
    if (this.docs) return this.docs;
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const days: IsoDate[] = [];
    for (let d = this.from; d <= toIso(Date.now()); d = addDays(d, 1)) days.push(d);
    const by = new Map<string, DocMeta[]>();
    let done = 0;
    const queue = [...days];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let d = queue.shift(); d; d = queue.shift()) {
          const file = path.join(this.cacheDir, `${d}.json`);
          let results: DocMeta[];
          if (fs.existsSync(file)) results = JSON.parse(fs.readFileSync(file, "utf8"));
          else {
            const j = (await (await this.get(`${API}/documents.json?date=${d}&type=2`)).json()) as { results?: DocMeta[] };
            results = (j.results ?? []).filter((r) => r.docTypeCode === ANNUAL_REPORT);
            // 今日と昨日の一覧はまだ増えるのでキャッシュしない
            if (d < addDays(toIso(Date.now()), -1)) fs.writeFileSync(file, JSON.stringify(results));
          }
          for (const r of results) {
            if (!r.edinetCode || r.withdrawalStatus !== "0" || r.csvFlag !== "1") continue;
            const arr = by.get(r.edinetCode) ?? [];
            arr.push(r);
            by.set(r.edinetCode, arr);
          }
          if (++done % 365 === 0) console.log(`  EDINET 書類一覧: ${done}/${days.length} 日`);
        }
      }),
    );
    this.docs = by;
    return by;
  }

  async annualReports(symbol: string): Promise<AnnualReport[]> {
    const code = await this.edinetCode(symbol);
    if (!code) return [];
    const docs = (await this.annualReportDocs()).get(code) ?? [];
    const out: AnnualReport[] = [];
    for (const d of docs) {
      const zip = unzipSync(new Uint8Array(await (await this.get(`${API}/documents/${d.docID}?type=5`)).arrayBuffer()));
      // 本文（jpcrp で始まる CSV）に経営指標が入っている
      const name = Object.keys(zip).find((n) => /XBRL_TO_CSV\/jpcrp.*\.csv$/.test(n));
      if (!name) continue;
      const v = perShareFromXbrlCsv(iconv.decode(Buffer.from(zip[name]), "utf16le"));
      out.push({
        periodEnd: (d.periodEnd ?? d.submitDateTime.slice(0, 10)) as IsoDate,
        reportDate: d.submitDateTime.slice(0, 10) as IsoDate,
        ...v,
      });
    }
    return out;
  }
}
