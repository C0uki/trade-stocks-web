import type { Metadata } from "next";
import { ja } from "@/lib/i18n/ja";
import { LegalPage } from "@/components/LegalPage";

export const metadata: Metadata = { title: `${ja.privacy.title} | ${ja.app.name}` };

export default function PrivacyPage() {
  return <LegalPage {...ja.privacy} />;
}
