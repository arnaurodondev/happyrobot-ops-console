import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Carrier Sales Ops Console",
    template: "%s · Carrier Sales Ops Console",
  },
  description:
    "Operational signals, audit trail and actions for the inbound carrier-sales agent. Reads the Twin system of record.",
  robots: { index: false, follow: false, nocache: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
