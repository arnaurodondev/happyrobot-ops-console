"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

/** Re-runs the server components for the current route. */
export function RefreshButton({ label = "Refresh" }: { label?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      className="btn sm"
      onClick={() => start(() => router.refresh())}
      disabled={pending}
      title="Re-query Twin for this view"
    >
      {pending ? "Refreshing…" : label}
    </button>
  );
}

/** Copy a run_id / MC / booking ref. The ops manager's most-used micro-action. */
export function CopyButton({
  value,
  label = "Copy",
  className = "btn sm ghost",
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1400);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      className={className}
      title={`Copy ${value}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
        } catch {
          /* clipboard blocked — nothing useful to say */
        }
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

export function SignOutButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      className="btn sm ghost"
      style={{ color: "#9aa6bb", justifyContent: "flex-start", padding: 0, height: "auto" }}
      disabled={pending}
      onClick={() =>
        start(async () => {
          await fetch("/api/auth/logout", { method: "POST" });
          router.replace("/login");
          router.refresh();
        })
      }
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}

/** Live UTC clock in the top bar — a standing reminder that every time is UTC. */
export function UtcClock() {
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    const tick = () =>
      setNow(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "UTC",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }).format(new Date()),
      );
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);
  // null on the server keeps hydration deterministic.
  return (
    <span className="mono" title="All timestamps in this console are UTC">
      {now ? `${now} UTC` : "—— UTC"}
    </span>
  );
}
