export default function Loading() {
  return (
    <main>
      <div className="monitor-shell">
        <header className="header-strip">
          <div className="loading-stack">
            <div className="loading-bar loading-bar-title" />
            <div className="loading-bar loading-bar-subtitle" />
            <div className="pill-row">
              <span className="status-pill skeleton-pill">Live</span>
              <span className="status-pill skeleton-pill">CME CL</span>
              <span className="status-pill skeleton-pill">Poly display mark</span>
            </div>
          </div>
          <div className="loading-stack loading-stack-right">
            <div className="loading-bar loading-bar-meta" />
            <div className="loading-bar loading-bar-meta" />
          </div>
        </header>

        <div className="status-ribbon status-ribbon-compact">
          <span className="status-pill skeleton-pill">Loading market snapshot...</span>
        </div>

        <section className="kpi-grid">
          {Array.from({ length: 4 }).map((_, index) => (
            <article className="kpi-card kpi-card-skeleton" key={index}>
              <div className="loading-bar loading-bar-label" />
              <div className="loading-bar loading-bar-value" />
              <div className="loading-bar loading-bar-subtext" />
            </article>
          ))}
        </section>

        <section className="charts-grid">
          <div className="chart-panel chart-panel-skeleton">
            <div className="chart-loading">Loading chart...</div>
          </div>
          <div className="chart-panel chart-panel-skeleton">
            <div className="chart-loading">Loading chart...</div>
          </div>
        </section>
      </div>
    </main>
  );
}
