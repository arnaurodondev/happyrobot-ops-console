import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { authConfigured, configuredUser, getSession } from "@/lib/auth";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  const params = await searchParams;

  const rawNext = typeof params.next === "string" ? params.next : "/";
  // Open-redirect guard: only same-origin absolute paths are ever honoured.
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";
  // Set by the no-JS POST path, which cannot hand a message to React state.
  // Without this a failed native submit returns a blank form and the user
  // cannot tell a wrong password from a broken page.
  const failed = params.error === "invalid" ? "Invalid credentials."
    : params.error === "locked"
      ? "Too many failed attempts. Locked for 15 minutes."
      : null;

  if (session) redirect(next);

  return (
    <main className="login-page">
      <div className="login-card">
        <div className="login-head">
          <div className="brand-mark">
            <span className="brand-dot" aria-hidden="true" />
            <span>Carrier Sales Ops Console</span>
          </div>
          <p>
            Internal operations console for HappyRobot Logistics. This console renders
            commercially sensitive rate data and carrier contact details.
          </p>
        </div>

        {authConfigured() ? (
          <LoginForm next={next} defaultUser={configuredUser()} initialError={failed} />
        ) : (
          <div className="login-body">
            <div className="callout bad">
              <span className="icon">✕</span>
              <div>
                <div className="strong">Console not configured</div>
                <div>
                  <code>OPS_CONSOLE_PASSWORD</code> is not set. The console refuses to
                  serve any data until a credential is configured — it will not fall
                  back to open access. Set it in the App&rsquo;s environment variables
                  (or <code>.env.local</code> when running locally) and redeploy.
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="login-foot">
          Access is a shared credential scoped to the review window, not SSO. Sessions
          last 8 hours, are signed server-side, and every API route re-checks the
          session independently of middleware.
        </div>
      </div>
    </main>
  );
}
