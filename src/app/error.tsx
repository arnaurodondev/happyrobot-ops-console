"use client";

import { useEffect } from "react";

/**
 * Last-resort boundary. It shows the digest, not the stack: a Postgres error
 * string can carry row values, and this page is reachable from the browser.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[ops-console] render error", error);
  }, [error]);

  return (
    <main className="login-page">
      <div className="login-card">
        <div className="login-head">
          <div className="brand-mark">
            <span className="brand-dot" aria-hidden="true" />
            <span>Carrier Sales Ops Console</span>
          </div>
          <p>
            The console could not render this screen. Nothing was written — this is a
            read-only console — so retrying is safe.
          </p>
        </div>
        <div className="login-body">
          {error.digest && (
            <div className="callout mute">
              <span className="icon">i</span>
              <div>
                Error digest <code>{error.digest}</code> — quote this when checking the
                App&rsquo;s build and runtime logs.
              </div>
            </div>
          )}
          <button type="button" className="btn primary" onClick={reset}>
            Try again
          </button>
          <a className="btn" href="/">
            Back to the overview
          </a>
        </div>
      </div>
    </main>
  );
}
