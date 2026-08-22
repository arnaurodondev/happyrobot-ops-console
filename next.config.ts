import type { NextConfig } from "next";

/**
 * The console renders max_buy and carrier PII on a PUBLIC URL
 * (https://<slug>.happyrobot.ai). Everything below is defence in depth on top
 * of the real control, which is the server-side session check in
 * src/lib/auth.ts — called as the first statement of every route handler and
 * every data-reading server component.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The console renders no images. Turning the optimizer off keeps the
  // next/image + sharp attack surface out of the deployment entirely.
  images: { unoptimized: true },
  // Twin rows are a system of record, never a cacheable page.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          {
            key: "Cache-Control",
            value: "no-store, no-cache, must-revalidate, private",
          },
          {
            // No external origins at all: no CDN, no remote fonts, no XHR off-host.
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              "font-src 'self'",
              "connect-src 'self'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
