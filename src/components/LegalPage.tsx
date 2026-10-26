import { CONTACT_URL, POLICY_DATE } from "@/config/site";
import { ja } from "@/lib/i18n/ja";

/** 利用規約・プライバシーポリシーの共通の見た目（ルールのページと同じ） */
export function LegalPage({
  title,
  lead,
  sections,
}: {
  title: string;
  lead: string;
  sections: readonly { heading: string; items: readonly string[] }[];
}) {
  return (
    <article className="panel mx-auto max-w-3xl space-y-6 p-6 text-sm leading-relaxed">
      <h1 className="text-xl font-bold">{title}</h1>
      <p>{lead}</p>
      {sections.map((s) => (
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
        <h2 className="mb-1.5 text-base font-semibold">{ja.legal.contactHeading}</h2>
        <p>
          {ja.legal.contactLead}
          <a href={CONTACT_URL} className="underline" target="_blank" rel="noreferrer">
            {CONTACT_URL}
          </a>
        </p>
        <p className="mt-1 text-xs text-muted">{ja.legal.contactNote}</p>
      </section>
      <p className="text-xs text-muted">{ja.legal.enacted(POLICY_DATE)}</p>
    </article>
  );
}
