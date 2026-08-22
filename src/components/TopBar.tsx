import type { ReactNode } from "react";
import { UtcClock } from "@/components/Actions";

export default function TopBar({
  title,
  crumb,
  actions,
}: {
  title: string;
  crumb?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="topbar">
      <h1>{title}</h1>
      {crumb && <span className="crumb">{crumb}</span>}
      <span className="topbar-spacer" />
      <div className="topbar-meta">
        <UtcClock />
        {actions}
      </div>
    </header>
  );
}
