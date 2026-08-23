"use client";

import { useState } from "react";
import { GoogleAuthProvider, signInWithPopup } from "firebase/auth";
import { useRouter } from "next/navigation";
import { clientAuth } from "@/lib/firebaseClient";

export default function LoginPage() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function signIn() {
    setBusy(true);
    setError("");
    try {
      const credential = await signInWithPopup(clientAuth(), new GoogleAuthProvider());
      const idToken = await credential.user.getIdToken();
      const response = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idToken }),
      });
      if (!response.ok) throw new Error("Could not create a secure session.");
      router.replace("/dashboard");
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Google sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <section className="w-full max-w-sm rounded-2xl border border-zinc-200 p-7 shadow-xl shadow-zinc-900/5 dark:border-zinc-800">
        <p className="text-sm font-semibold">Harmonia</p>
        <h1 className="mt-6 text-2xl font-semibold">Create or open your workspace</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-500">
          Continue with Google. Your jobs, connections, memory, assets, and publishing approvals stay isolated in your workspace.
        </p>
        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
        <button
          type="button"
          onClick={signIn}
          disabled={busy}
          className="mt-6 flex w-full items-center justify-center gap-3 rounded-full border border-zinc-300 px-4 py-2.5 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          <span aria-hidden className="text-base font-bold text-blue-600">G</span>
          {busy ? "Signing in…" : "Continue with Google"}
        </button>
      </section>
    </main>
  );
}
