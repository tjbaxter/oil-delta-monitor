import type { Metadata } from "next";
import type { ReactNode } from "react";

import "@/app/globals.css";

export const metadata: Metadata = {
  title: "CL Delta Scope",
  description: "Real-time Kalshi WTI daily probabilities versus a crude-options-derived call-spread fair value."
};

const criticalCSS = `
:root{--bg:#05080f;--panel:#091220;--text:#e6eef8;--muted:#91a0b7;--poly:#27d3c3;--theo:#ff8b3d;--crude:#b9a26a;--positive:#2ec27e;--negative:#f66151;--border:#16283a}
*{box-sizing:border-box}
body,html{margin:0;min-height:100%;background:#05080f;color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,sans-serif}
.monitor-shell{display:grid;gap:10px}
.header-strip{display:flex;justify-content:space-between;padding:14px 16px;border:1px solid rgba(22,40,58,.7);border-radius:14px;background:rgba(9,18,32,.94)}
.header-title{font-size:19px;font-weight:700}
.header-subtitle{margin-top:4px;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.11em}
.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.kpi-card{min-height:112px;padding:11px 13px;border:1px solid rgba(22,40,58,.58);border-radius:14px;background:rgba(9,18,32,.94);position:relative;overflow:hidden}
.kpi-card::before{content:"";position:absolute;top:0;left:0;width:100%;height:2px;opacity:.75}
.accent-poly::before{background:var(--poly)}
.accent-theo::before{background:var(--theo)}
.accent-crude::before{background:var(--crude)}
.kpi-label{color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.13em}
.kpi-value{margin-top:12px;font-size:32px;font-weight:700;line-height:1.1}
.kpi-value-poly{color:var(--poly)}
.kpi-value-theo{color:var(--theo)}
.kpi-subtext{margin-top:7px;color:var(--muted);font-size:10px}
.kpi-card-hero .kpi-value{font-size:38px}
.charts-grid{display:grid;grid-template-columns:1.05fr 1fr;gap:10px}
.chart-panel{min-height:340px;border:1px solid rgba(22,40,58,.58);border-radius:14px;background:rgba(9,18,32,.94);position:relative}
.pill-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.status-pill{display:inline-flex;padding:4px 9px;border-radius:999px;border:1px solid rgba(22,40,58,.78);background:rgba(12,22,38,.9);font-size:10px}
.status-pill-replay{background:rgba(39,211,195,.12);color:var(--poly);border-color:rgba(39,211,195,.25)}
@media(max-width:1200px){.charts-grid,.kpi-grid{grid-template-columns:1fr}}
`;

export default function RootLayout({
  children
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        {/* Critical CSS inlined FIRST to enable immediate paint */}
        <style dangerouslySetInnerHTML={{ __html: criticalCSS }} />
        {/* 
          Make Next.js external stylesheet non-blocking by setting media=print.
          This runs synchronously before the browser processes the stylesheet link.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              document.addEventListener('DOMContentLoaded', function() {
                var css = document.querySelector('link[href*="/_next/static/css"]');
                if (css && css.media !== 'all') {
                  css.media = 'all';
                }
              });
            `
          }}
        />
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
