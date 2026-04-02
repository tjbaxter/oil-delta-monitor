import DashboardShell from "@/components/dashboard/DashboardShell";
import { DEFAULT_MARKET_SLUG, DEFAULT_MONITOR_MODE } from "@/lib/constants";

export default function HomePage() {
  return (
    <main>
      <DashboardShell
        initialMode={DEFAULT_MONITOR_MODE}
        initialSlug={DEFAULT_MARKET_SLUG}
      />
    </main>
  );
}
