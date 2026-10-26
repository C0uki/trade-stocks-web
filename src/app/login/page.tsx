import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, devLoginEnabled, signIn } from "@/auth";
import { ja } from "@/lib/i18n/ja";

export default async function LoginPage() {
  if ((await auth())?.user) redirect("/");
  const c = ja.login.consent;
  return (
    <div className="panel mx-auto max-w-sm p-6">
      <h1 className="text-xl font-bold">{ja.login.title}</h1>
      <div className="mt-5 flex flex-col gap-3">
        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/" });
          }}
        >
          <button className="btn w-full">{ja.login.google}</button>
        </form>
        <form
          action={async () => {
            "use server";
            await signIn("github", { redirectTo: "/" });
          }}
        >
          <button className="btn w-full">{ja.login.github}</button>
        </form>
      </div>
      <p className="mt-4 text-xs text-muted">
        {c[0]}
        <Link href="/terms" className="underline">
          {c[1]}
        </Link>
        {c[2]}
        <Link href="/privacy" className="underline">
          {c[3]}
        </Link>
        {c[4]}
      </p>
      {devLoginEnabled && (
        <form
          className="mt-6 border-t border-line pt-5"
          action={async (fd: FormData) => {
            "use server";
            await signIn("dev", { name: String(fd.get("name") ?? ""), redirectTo: "/" });
          }}
        >
          <p className="mb-2 text-sm font-semibold">{ja.login.dev}</p>
          <label className="text-sm text-muted">
            {ja.login.devName}
            <input name="name" className="input mt-1" required pattern="[\w\-]{1,32}" />
          </label>
          <button className="btn btn-primary mt-3 w-full">{ja.login.title}</button>
        </form>
      )}
    </div>
  );
}
