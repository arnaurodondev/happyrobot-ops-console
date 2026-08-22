import Link from "next/link";
import { requireSession } from "@/lib/auth";
import Nav from "@/components/Nav";
import { SignOutButton } from "@/components/Actions";

export const dynamic = "force-dynamic";

/**
 * The console shell. `requireSession()` is the first statement — but it is not
 * the only gate: every page and every route handler under here calls it again
 * as *its* first statement. Layouts do not re-run on every navigation in the
 * App Router, and a layout is not a security boundary any more than middleware
 * is (CVE-2025-29927). The per-page check is the one that counts.
 */
export default async function ConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSession();

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Link href="/" className="brand-mark" style={{ textDecoration: "none" }}>
            <span className="brand-dot" aria-hidden="true" />
            <span>Carrier Sales Ops</span>
          </Link>
          <div className="brand-sub">HappyRobot Logistics</div>
        </div>

        <Nav />

        <div className="sidebar-foot">
          <div>
            <span className="who">{session.user}</span>
            <div style={{ fontSize: 10.5 }}>Shared review credential</div>
          </div>
          <SignOutButton />
          <div style={{ fontSize: 10, lineHeight: 1.5, color: "#5b6679" }}>
            Source of record: HappyRobot Twin. No platform run logs are read.
          </div>
        </div>
      </aside>

      <div className="main">{children}</div>
    </div>
  );
}
