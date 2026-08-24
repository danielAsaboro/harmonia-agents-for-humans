"use client";

import { useEffect, useRef, useState } from "react";
import { browserLocalPersistence, GoogleAuthProvider, onAuthStateChanged, setPersistence, signInWithPopup, signOut as firebaseSignOut } from "firebase/auth";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { clientAuth } from "@/lib/firebaseClient";
import { establishPersistedIdentity, restorePersistedSession, shouldRestorePersistedSession } from "@/lib/sessionPersistence";

export default function LoginPage() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const interactiveSignIn = useRef(false);

  async function createServerSession(idToken: string): Promise<boolean> {
    const response = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    return response.ok;
  }

  useEffect(() => {
    return onAuthStateChanged(clientAuth(), async (user) => {
      if (!user || interactiveSignIn.current) return;
      if (!shouldRestorePersistedSession(user.metadata.lastSignInTime)) {
        await firebaseSignOut(clientAuth());
        return;
      }
      setBusy(true);
      try {
        const restored = await restorePersistedSession(user, createServerSession);
        if (!restored) return;
        router.replace("/dashboard");
        router.refresh();
      } catch {
        // Keep the interactive Google option available when silent restoration fails.
      } finally {
        setBusy(false);
      }
    });
  }, [router]);

  async function signIn() {
    interactiveSignIn.current = true;
    setBusy(true);
    setError("");
    try {
      const modeResponse = await fetch("/api/auth/session", { cache: "no-store" });
      const mode = await modeResponse.json() as { devBypassEnabled?: boolean };
      if (mode.devBypassEnabled) {
        const response = await fetch("/api/auth/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ devBypass: true }),
        });
        if (!response.ok) throw new Error("Could not create a local development session.");
        router.replace("/dashboard");
        router.refresh();
        return;
      }
      const auth = clientAuth();
      const credential = await establishPersistedIdentity(
        () => setPersistence(auth, browserLocalPersistence),
        () => signInWithPopup(auth, new GoogleAuthProvider()),
      );
      const idToken = await credential.user.getIdToken();
      if (!await createServerSession(idToken)) throw new Error("Could not create a secure session.");
      router.replace("/dashboard");
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Google sign-in failed.");
    } finally {
      interactiveSignIn.current = false;
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <section className="w-full max-w-sm rounded-2xl border border-zinc-200 p-7 shadow-xl shadow-zinc-900/5 dark:border-zinc-800">
        <div className="flex items-center gap-3 text-sm font-semibold"><BrandMark className="h-10 w-14 rounded-xl bg-[#080b08] object-contain" decorative />Harmonia</div>
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
