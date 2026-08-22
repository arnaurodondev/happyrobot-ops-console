"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LoginForm({
  next,
  defaultUser,
}: {
  next: string;
  defaultUser: string;
}) {
  const router = useRouter();
  const [user, setUser] = useState(defaultUser);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        router.replace(next);
        router.refresh();
        return;
      }
      setError(
        body.message ??
          (res.status === 429
            ? "Too many attempts. Try again shortly."
            : "Sign-in failed."),
      );
    } catch {
      setError("Could not reach the console. Check the network and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="login-body" onSubmit={submit}>
      {error && (
        <div className="callout bad" role="alert">
          <span className="icon">✕</span>
          <div>{error}</div>
        </div>
      )}

      <div className="field">
        <label htmlFor="user">User</label>
        <input
          id="user"
          name="user"
          type="text"
          value={user}
          autoComplete="username"
          onChange={(e) => setUser(e.target.value)}
          required
        />
      </div>

      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          required
        />
      </div>

      <button type="submit" className="btn accent" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
