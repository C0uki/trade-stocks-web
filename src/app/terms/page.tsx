import type { Metadata } from "next";
import { ja } from "@/lib/i18n/ja";
import { LegalPage } from "@/components/LegalPage";

export const metadata: Metadata = { title: `${ja.terms.title} | ${ja.app.name}` };

export default function TermsPage() {
  return <LegalPage {...ja.terms} />;
}
