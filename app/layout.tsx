import type { Metadata } from "next";
import type { ReactNode } from "react";

import "@/app/globals.css";

export const metadata: Metadata = {
  title: "CL Delta Scope",
  description: "Real-time Kalshi WTI daily probabilities versus a crude-options-derived call-spread fair value."
};

export default function RootLayout({
  children
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <link
          rel="preload"
          href="/replay/default-session.json"
          as="fetch"
          crossOrigin="anonymous"
        />
        {/* Prime the browser cache for the live snapshot before React even boots */}
        <link
          rel="preload"
          href="/api/live-snapshot"
          as="fetch"
          crossOrigin="anonymous"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
