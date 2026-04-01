import type { SnapshotMode } from "@/lib/types";

interface EmptyStatePanelsProps {
  isLoading: boolean;
  mode: SnapshotMode;
}

export default function EmptyStatePanels({
  isLoading,
  mode
}: EmptyStatePanelsProps) {
  const liveMode = mode === "live";

  return (
    <section className="empty-instructions">
      {isLoading ? (
        <>
          {liveMode ? (
            <>
              <span>1) reading locally recorded live snapshot</span>
              <span>2) waiting for the ingestor to seed CL + Kalshi state</span>
              <span>3) recomputing fair value and delta locally</span>
            </>
          ) : (
            <>
              <span>1) loading delayed Databento window</span>
              <span>2) loading matching Polymarket history</span>
              <span>3) pairing observations and computing fair value</span>
            </>
          )}
        </>
      ) : (
        <>
          {liveMode ? (
            <>
              <span>1) start `python3 services/live_ingestor/main.py`</span>
              <span>2) wait for `data/live_snapshot.json` to be written</span>
              <span>3) refresh the local live snapshot</span>
            </>
          ) : (
            <>
              <span>1) verify `DATABENTO_API_KEY` in `.env.local`</span>
              <span>2) confirm the market slug</span>
              <span>3) refresh the delayed window</span>
            </>
          )}
        </>
      )}
    </section>
  );
}
