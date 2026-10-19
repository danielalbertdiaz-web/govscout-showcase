"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErr(data.error === "invalid_credentials" ? "Invalid email or password." : "Sign-in failed.");
        return;
      }
      router.replace(next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-4">
      {/* Branded backdrop: deep navy with gold + blue light sources. */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(900px 600px at 18% -10%, rgba(59,130,246,0.18), transparent 55%), radial-gradient(820px 560px at 100% 110%, rgba(212,168,83,0.22), transparent 55%), linear-gradient(180deg, #0a0e1a 0%, #0f1629 100%)",
        }}
      />
      {/* Brand art panel (Nano Banana, navy/gold) — desktop only. The PNG's
          own navy ground blends into the backdrop, so it reads as one scene. */}
      <div aria-hidden className="gs-rise mr-14 hidden w-[380px] flex-col items-center lg:flex">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/assets/brand/login-hero.png"
          alt=""
          className="w-full max-w-[340px] mix-blend-screen"
          style={{
            filter: "drop-shadow(0 0 60px rgba(212,168,83,0.15))",
            // Feather the PNG's square boundary into the gradient backdrop.
            // closest-side: the mask reaches fully-transparent AT the image
            // edge — the previous farthest-corner circle still showed the
            // square boundary ("cut off in a box", operator 2026-06-11).
            maskImage: "radial-gradient(circle closest-side at center, black 45%, transparent 96%)",
            WebkitMaskImage: "radial-gradient(circle closest-side at center, black 45%, transparent 96%)",
          }}
        />
        <p className="mt-2 max-w-[320px] text-center text-sm leading-6 text-stone-400">
          Every funding channel, one radar — federal notices, unspent balances,
          settlement boards, and 1,400+ mapped funders.
        </p>
      </div>
      <form
        onSubmit={submit}
        className="gs-rise w-full max-w-sm space-y-5 rounded-2xl border border-white/10 bg-white p-8"
        style={{ boxShadow: "0 24px 60px -12px rgba(0,0,0,0.55), 0 0 0 1px rgba(212,168,83,0.08)" }}
      >
        {/* Gold accent hairline across the top of the card. */}
        <div
          aria-hidden
          className="-mx-8 -mt-8 mb-2 h-1 rounded-t-2xl"
          style={{ background: "linear-gradient(90deg, var(--gs-gold-dark), var(--gs-gold-light), var(--gs-gold-dark))" }}
        />
        <div>
          <div className="flex items-center gap-2.5">
            <svg viewBox="0 0 40 40" fill="none" aria-hidden className="h-7 w-7 text-[#3B82F6]">
              <rect x="4" y="8" width="32" height="24" rx="3" stroke="currentColor" strokeWidth="2" />
              <path d="M12 18L18 24L28 14" stroke="#D4A853" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="20" cy="6" r="3" fill="#D4A853" />
              <line x1="20" y1="3" x2="20" y2="0" stroke="#D4A853" strokeWidth="1.5" />
            </svg>
            <span className="text-base font-extrabold tracking-tight text-stone-900">
              Gov<span className="text-[#b8913e]">Scout</span>
            </span>
          </div>
          <h1 className="mt-4 text-2xl font-semibold text-stone-900">Sign in</h1>
          <p className="mt-1 text-sm text-stone-600">AI grant proposal drafting workbench.</p>
        </div>
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wider text-stone-700">Email</span>
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 shadow-sm placeholder:text-stone-400 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
          />
        </label>
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wider text-stone-700">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 shadow-sm placeholder:text-stone-400 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
          />
        </label>
        {err && (
          <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
            {err}
          </div>
        )}
        <button type="submit" disabled={busy} className="gs-btn gs-btn-primary w-full">
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
