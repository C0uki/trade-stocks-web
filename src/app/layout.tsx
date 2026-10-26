import type { Metadata } from "next";
import Link from "next/link";
import { auth, signOut } from "@/auth";
import { CONTACT_URL } from "@/config/site";
import { ja } from "@/lib/i18n/ja";
import "./globals.css";

export const metadata: Metadata = {
  title: ja.app.name,
  description: ja.app.description,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body className="min-h-screen antialiased">
        <Header />
        <main className="mx-auto max-w-[1400px] px-4 py-5">{children}</main>
        <Footer />
      </body>
    </html>
  );
}

async function Header() {
  const session = await auth();
  return (
    <header className="border-b border-line bg-panel">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
        <Link href="/" className="text-lg font-bold tracking-tight">
          {ja.app.name}
        </Link>
        <nav className="flex flex-wrap gap-4 text-sm text-muted">
          <Link href="/" className="hover:text-fg">
            {ja.nav.home}
          </Link>
          <Link href="/practice" className="hover:text-fg">
            {ja.nav.practice}
          </Link>
          <Link href="/ranking" className="hover:text-fg">
            {ja.nav.ranking}
          </Link>
          <Link href="/rules" className="hover:text-fg">
            {ja.nav.rules}
          </Link>
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          {session?.user ? (
            <>
              <Link href="/settings" className="text-muted hover:text-fg">
                {session.user.name ?? ja.nav.settings}
              </Link>
              <form
                action={async () => {
                  "use server";
                  await signOut({ redirectTo: "/" });
                }}
              >
                <button className="btn">{ja.nav.logout}</button>
              </form>
            </>
          ) : (
            <Link href="/login" className="btn btn-primary">
              {ja.nav.login}
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="border-t border-line">
      <nav className="mx-auto flex max-w-[1400px] flex-wrap gap-x-5 gap-y-2 px-4 py-4 text-xs text-muted">
        <Link href="/rules" className="hover:text-fg">
          {ja.nav.rules}
        </Link>
        <Link href="/terms" className="hover:text-fg">
          {ja.footer.terms}
        </Link>
        <Link href="/privacy" className="hover:text-fg">
          {ja.footer.privacy}
        </Link>
        <a href={CONTACT_URL} className="hover:text-fg" target="_blank" rel="noreferrer">
          {ja.footer.contact}
        </a>
      </nav>
    </footer>
  );
}
