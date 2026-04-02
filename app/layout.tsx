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
        {/* Preload the default replay JSON so the browser fetches it in parallel
            with the JS bundle — by the time React hydrates, it's already cached. */}
        <link
          rel="preload"
          href="/replay/default-session.json"
          as="fetch"
          crossOrigin="anonymous"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
