"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LoginForm({
  next,
  defaultUser,
  initialError,
}: {
  next: string;
  defaultUser: string;
  initialError?: string | null;
}) {
  const router = useRouter();
  const [user, setUser] = useState(defaultUser);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(initialError ?? null);
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
    <form
      className="login-body"
      // method/action matter even though `submit` normally intercepts. If the
      // client bundle has not hydrated — a JS error, a slow chunk, a blocked
      // script — the browser submits this form NATIVELY. Without them that is
      // a GET to the current URL, which puts the password in the query string,
      // the address bar and the access log, and lands the user back on the
      // login page looking like nothing happened. That is exactly what it did.
      // With them, the no-JS path is a real POST that sets the session and
      // redirects, so the form works whether or not React is alive.
      method="post"
      action="/api/auth/login"
      onSubmit={submit}
    >
      <input type="hidden" name="next" value={next} />
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
