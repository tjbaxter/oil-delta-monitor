import type { ReplayPayload } from "@/lib/types";
import { DASHBOARD_TITLE } from "@/lib/constants";

interface ReplayPreviewProps {
  sessionData: ReplayPayload;
  animationStartIndex?: number;
}

function formatPrice(price: number | null): string {
  if (price === null) return "—";
  return `$${price.toFixed(2)}`;
}

function formatCents(prob: number | null): string {
  if (prob === null) return "—";
  return `${Math.round(prob * 100)}¢`;
}

function formatGapCents(gap: number | null): string {
  if (gap === null) return "—";
  const cents = Math.round(gap * 100);
  return cents >= 0 ? `+${cents}¢` : `${cents}¢`;
}

export default function ReplayPreview({ sessionData, animationStartIndex }: ReplayPreviewProps) {
  const startIdx = animationStartIndex ?? Math.floor(sessionData.observations.length * 0.7);
  const visibleObs = sessionData.observations.slice(0, startIdx + 1);
  const last = visibleObs[visibleObs.length - 1];
  
  const pricing = sessionData.pricingDefaults;
  const strike = pricing?.strike ?? 100;
  const spreadWidth = pricing?.spreadWidth ?? 1;
  const spreadLow = (strike - spreadWidth / 2).toFixed(1);
  const spreadHigh = (strike + spreadWidth / 2).toFixed(1);

  const gapTone = last?.fairValueGap !== null && last.fairValueGap > 0
    ? { color: "#f59e0b", message: "Market rich - sell signal" }
    : { color: "#2ec27e", message: "Market cheap - buy signal" };

  const prices = visibleObs.map(o => o.crudePrice).filter((p): p is number => p !== null);
  const fairProbs = visibleObs.map(o => o.fairProb).filter((p): p is number => p !== null);
  const polyProbs = visibleObs.map(o => o.polyProb).filter((p): p is number => p !== null);
  
  const minProb = Math.min(...fairProbs, ...polyProbs, 0);
  const maxProb = Math.max(...fairProbs, ...polyProbs, 1);
  const probRange = maxProb - minProb || 1;

  const width = 100;
  const height = 50;
  const padding = 2;

  const normalizeX = (idx: number) => padding + (idx / Math.max(visibleObs.length - 1, 1)) * (width - 2 * padding);
  const normalizeY = (prob: number) => height - padding - ((prob - minProb) / probRange) * (height - 2 * padding);

  const fairPath = visibleObs
    .map((o, i) => {
      if (o.fairProb === null) return null;
      return `${i === 0 ? 'M' : 'L'}${normalizeX(i).toFixed(1)},${normalizeY(o.fairProb).toFixed(1)}`;
    })
    .filter(Boolean)
    .join(' ');

  const polyPath = visibleObs
    .map((o, i) => {
      if (o.polyProb === null) return null;
      return `${i === 0 ? 'M' : 'L'}${normalizeX(i).toFixed(1)},${normalizeY(o.polyProb).toFixed(1)}`;
    })
    .filter(Boolean)
    .join(' ');

  return (
    <div className="monitor-shell">
      <header className="header-strip">
        <div className="loading-stack">
          <div className="header-title">{DASHBOARD_TITLE}</div>
          <div className="header-subtitle">Market replay — real captured session data</div>
          <div className="pill-row">
            <span className="status-pill status-pill-replay">Replay</span>
            <span className="status-pill">CME CL</span>
            <span className="status-pill">Kalshi midpoint</span>
            {last?.timestamp && (
              <span className="status-pill">
                {new Date(last.timestamp).toISOString().slice(11, 19)} UTC
              </span>
            )}
          </div>
        </div>
      </header>

      <section className="kpi-grid">
        <div className="kpi-card accent-crude">
          <div className="kpi-label">CL FRONT MONTH</div>
          <div className="kpi-value">{formatPrice(last?.crudePrice ?? null)}</div>
          <div className="kpi-subtext">{sessionData.crudeSubLabel}</div>
        </div>
        <div className="kpi-card accent-poly">
          <div className="kpi-label">KALSHI YES</div>
          <div className="kpi-value kpi-value-poly">{formatCents(last?.polyProb ?? null)}</div>
          <div className="kpi-subtext">
            implied prob {last?.polyProb !== null ? `${(last.polyProb * 100).toFixed(1)}%` : "—"}
          </div>
        </div>
        <div className="kpi-card accent-theo">
          <div className="kpi-label">{spreadLow}/{spreadHigh} SPREAD VALUE</div>
          <div className="kpi-value kpi-value-theo">{formatCents(last?.fairProb ?? null)}</div>
          <div className="kpi-subtext">tight Black-Scholes call spread</div>
        </div>
        <div className="kpi-card kpi-card-hero" style={{ borderColor: `${gapTone.color}40` }}>
          <div className="kpi-label">KALSHI - THEO</div>
          <div className="kpi-value" style={{ color: gapTone.color }}>
            {formatGapCents(last?.fairValueGap ?? null)}
          </div>
          <div className="kpi-subtext" style={{ color: gapTone.color }}>{gapTone.message}</div>
        </div>
      </section>

      <section className="charts-grid">
        <div className="chart-panel" style={{ minHeight: 340, position: "relative" }}>
          <div style={{
            position: "absolute",
            top: 12,
            left: 14,
            fontSize: 10,
            color: "var(--muted)",
            textTransform: "uppercase",
            letterSpacing: "0.1em"
          }}>
            Probability vs Time
          </div>
          <div style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            width: "90%",
            height: "65%"
          }}>
            <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ width: "100%", height: "100%" }}>
              {fairPath && <path d={fairPath} fill="none" stroke="var(--theo)" strokeWidth="0.6" opacity="0.9" />}
              {polyPath && <path d={polyPath} fill="none" stroke="var(--poly)" strokeWidth="0.6" opacity="0.9" />}
            </svg>
          </div>
          <div style={{
            position: "absolute",
            bottom: 12,
            left: 14,
            display: "flex",
            gap: 16,
            fontSize: 10
          }}>
            <span style={{ color: "var(--theo)" }}>● Fair value</span>
            <span style={{ color: "var(--poly)" }}>● Kalshi</span>
          </div>
        </div>
        <div className="chart-panel" style={{ minHeight: 340, position: "relative" }}>
          <div style={{
            position: "absolute",
            top: 12,
            left: 14,
            fontSize: 10,
            color: "var(--muted)",
            textTransform: "uppercase",
            letterSpacing: "0.1em"
          }}>
            Delta Scatter
          </div>
          <div style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            width: "90%",
            height: "65%"
          }}>
            <svg viewBox="0 0 100 50" preserveAspectRatio="none" style={{ width: "100%", height: "100%" }}>
              {visibleObs.slice(-50).map((o, i) => {
                if (o.crudePrice === null || o.fairProb === null) return null;
                const minP = Math.min(...prices);
                const maxP = Math.max(...prices);
                const x = 5 + ((o.crudePrice - minP) / (maxP - minP || 1)) * 90;
                const y = 45 - ((o.fairProb - minProb) / probRange) * 40;
                return <circle key={i} cx={x} cy={y} r="0.8" fill="var(--theo)" opacity="0.7" />;
              })}
              {visibleObs.slice(-50).map((o, i) => {
                if (o.crudePrice === null || o.polyProb === null) return null;
                const minP = Math.min(...prices);
                const maxP = Math.max(...prices);
                const x = 5 + ((o.crudePrice - minP) / (maxP - minP || 1)) * 90;
                const y = 45 - ((o.polyProb - minProb) / probRange) * 40;
                return <circle key={`p${i}`} cx={x} cy={y} r="0.8" fill="var(--poly)" opacity="0.7" />;
              })}
            </svg>
          </div>
        </div>
      </section>

      <div style={{
        textAlign: "center",
        padding: "12px 0",
        fontSize: 11,
        color: "var(--muted)",
        opacity: 0.7
      }}>
        Loading interactive controls…
      </div>
    </div>
  );
}
