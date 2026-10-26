import type { IsoDate } from "../../../src/lib/engine/calendar";
import type { AnnualReport } from "./common";

/**
 * SEC EDGAR の XBRL（companyfacts）から、通期（10-K）の EPS と BPS を取り出す。
 * 同じ期の数字が後から修正されていても、最初に提出された値を使う（その時点で分かっていた数字）。
 */

type Fact = { start?: string; end: string; val: number; accn: string; form: string; filed: string };
type CompanyFacts = {
  facts: Record<string, Record<string, { units: Record<string, Fact[]> } | undefined> | undefined>;
};

const ANNUAL_FORMS = new Set(["10-K", "10-K/A", "20-F", "40-F"]);
const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;

function facts(j: CompanyFacts, taxonomy: string, names: string[], unit: string): Fact[] {
  for (const n of names) {
    const f = j.facts[taxonomy]?.[n]?.units[unit];
    if (f?.length) return f.filter((x) => ANNUAL_FORMS.has(x.form));
  }
  return [];
}

/** 期末ごとに、最初に提出された値 */
function firstFiled(fs: Fact[]): Map<string, Fact> {
  const by = new Map<string, Fact>();
  for (const f of fs) {
    const cur = by.get(f.end);
    if (!cur || f.filed < cur.filed) by.set(f.end, f);
  }
  return by;
}

export function annualReportsFromCompanyFacts(j: CompanyFacts): AnnualReport[] {
  // EPS は1年間（330〜400日）の値だけ
  const eps = firstFiled(
    facts(j, "us-gaap", ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted", "EarningsPerShareBasic"], "USD/shares").filter(
      (f) => f.start && days(f.start, f.end) > 330 && days(f.start, f.end) < 400,
    ),
  );
  const equity = firstFiled(
    facts(j, "us-gaap", ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"], "USD"),
  );
  // 発行済株式数は表紙（dei）の値を、提出書類ごとに合計する（種類株が複数あるため）
  const sharesByAccn = new Map<string, number>();
  for (const f of facts(j, "dei", ["EntityCommonStockSharesOutstanding"], "shares")) {
    sharesByAccn.set(f.accn, (sharesByAccn.get(f.accn) ?? 0) + f.val);
  }
  const out: AnnualReport[] = [];
  for (const [end, e] of eps) {
    const eq = equity.get(end);
    const shares = eq ? sharesByAccn.get(eq.accn) : undefined;
    out.push({
      periodEnd: end as IsoDate,
      reportDate: e.filed as IsoDate,
      eps: e.val,
      bps: eq && shares ? eq.val / shares : null,
    });
  }
  return out;
}

export class SecClient {
  private tickers: Map<string, number> | null = null;
  constructor(private readonly contact: string) {}

  private async get<T>(url: string): Promise<T> {
    const res = await fetch(url, { headers: { "User-Agent": `trade-stocks-web ${this.contact}` } });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return (await res.json()) as T;
  }

  /** ティッカーから CIK を引く */
  async cik(ticker: string): Promise<number | null> {
    if (!this.tickers) {
      const t = await this.get<Record<string, { cik_str: number; ticker: string }>>(
        "https://www.sec.gov/files/company_tickers.json",
      );
      // 同じティッカーが複数の会社（持株会社の新設など）に付いていることがあるので、先に載っている方を使う
      this.tickers = new Map();
      for (const x of Object.values(t)) {
        const key = x.ticker.toUpperCase();
        if (!this.tickers.has(key)) this.tickers.set(key, x.cik_str);
      }
    }
    const t = ticker.toUpperCase();
    // 種類株の表記は BRK.B / BRK-B の両方がある
    return this.tickers.get(t) ?? this.tickers.get(t.replace(".", "-")) ?? this.tickers.get(t.replace("-", ".")) ?? null;
  }

  async annualReports(ticker: string): Promise<AnnualReport[]> {
    const cik = await this.cik(ticker);
    if (!cik) return [];
    const j = await this.get<CompanyFacts>(
      `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, "0")}.json`,
    );
    return annualReportsFromCompanyFacts(j);
  }
}
