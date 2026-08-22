"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  {
    group: "Operations",
    items: [
      { href: "/", label: "Overview", exact: true },
      { href: "/calls", label: "Call log" },
      { href: "/carriers", label: "Carriers" },
    ],
  },
  {
    group: "Compliance",
    items: [
      { href: "/calls?flagged=1", label: "Flagged calls" },
      { href: "/calls?outcome=booked&tms=ambiguous", label: "TMS exceptions" },
    ],
  },
];

export default function Nav({ counts }: { counts?: Record<string, number> }) {
  const pathname = usePathname();

  return (
    <nav className="nav" aria-label="Primary">
      {LINKS.map((group) => (
        <div className="nav-group" key={group.group}>
          <div className="nav-label">{group.group}</div>
          {group.items.map((item) => {
            const base = item.href.split("?")[0];
            const active = item.exact
              ? pathname === base
              : pathname === base || pathname.startsWith(`${base}/`);
            const count = counts?.[item.href];
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active && !item.href.includes("?") ? "page" : undefined}
              >
                <span>{item.label}</span>
                {typeof count === "number" && count > 0 && (
                  <span className="nav-count">{count}</span>
                )}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
