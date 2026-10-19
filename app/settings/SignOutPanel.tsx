"use client";

// Operator-requested (2026-06-11): a sign-out control in Settings, in
// addition to the header button. POSTs the existing logout route (clears the
// gs_session cookie) and lands on /login.

import { useState } from "react";
import { useRouter } from "next/navigation";

export function SignOutPanel({ email }: { email: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.replace("/login");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-stone-600">Session</h2>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-stone-700">
          Signed in as <span className="font-semibold">{email}</span>. Signing out clears this
          browser&rsquo;s session; other devices stay signed in until their sessions expire.
        </p>
        <button
          type="button"
          onClick={() => void signOut()}
          disabled={busy}
          className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 shadow-sm hover:bg-red-50 disabled:opacity-60"
        >
          {busy ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </section>
  );
}
