interface KpiCardProps {
  label: string;
  value: string;
  subtext: string;
  accentClass?: string;
  className?: string;
  valueClassName?: string;
  subtextClassName?: string;
}

export default function KpiCard({
  label,
  value,
  subtext,
  accentClass,
  className,
  valueClassName,
  subtextClassName
}: KpiCardProps) {
  return (
    <article className={`kpi-card ${accentClass ?? ""} ${className ?? ""}`.trim()}>
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${valueClassName ?? ""}`.trim()}>{value}</div>
      <div className={`kpi-subtext ${subtextClassName ?? ""}`.trim()}>{subtext}</div>
    </article>
  );
}
