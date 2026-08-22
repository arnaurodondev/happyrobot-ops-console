import Link from "next/link";
import { RANGES } from "@/lib/queries";

export default function RangeChips({
  active,
  basePath,
  extra = {},
}: {
  active: string;
  basePath: string;
  extra?: Record<string, string | undefined>;
}) {
  return (
    <div className="chips" role="group" aria-label="Time window">
      {Object.entries(RANGES).map(([key, spec]) => {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(extra)) if (v) params.set(k, v);
        params.set("range", key);
        return (
          <Link
            key={key}
            className="chip"
            href={`${basePath}?${params.toString()}`}
            aria-current={key === active ? "true" : undefined}
          >
            {spec.label}
          </Link>
        );
      })}
    </div>
  );
}
