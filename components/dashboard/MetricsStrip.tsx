import { formatNumber } from "@/lib/format";

interface MetricsStripProps {
  empiricalDelta: number | null;
  theoreticalDelta: number | null;
  deltaGap: number | null;
  slopeRatio: number | null;
}

export default function MetricsStrip({
  empiricalDelta,
  theoreticalDelta,
  deltaGap,
  slopeRatio
}: MetricsStripProps) {
  return (
    <section className="metrics-strip">
      <div className="metric-cell">
        <span className="metric-label">Empirical delta (roll)</span>
        <strong>{formatNumber(empiricalDelta, 3)}</strong>
      </div>
      <div className="metric-cell">
        <span className="metric-label">Theo spread delta</span>
        <strong>{formatNumber(theoreticalDelta, 4)}</strong>
      </div>
      <div className="metric-cell">
        <span className="metric-label">Delta gap</span>
        <strong>{formatNumber(deltaGap, 3)}</strong>
      </div>
      <div className="metric-cell">
        <span className="metric-label">Slope ratio</span>
        <strong>{slopeRatio === null ? "—" : `${slopeRatio.toFixed(2)}x`}</strong>
      </div>
    </section>
  );
}
