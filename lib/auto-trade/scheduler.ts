// Ticks /api/cron/auto-trade and /api/cron/paper once a minute from inside the
// server process, so auto mode and paper trading work with nothing but
// `npm run dev` / `npm start`. The route
// decides whether a run is due; this only knocks. Going through the route
// (rather than calling the engine here) keeps the engine inside Next's route
// runtime, where its imports of the other route handlers resolve normally.
//
// AUTO_TRADE_SCHEDULER=off disables it (use an external cron instead).

const TICK_MS = 60_000;

export function startAutoTradeScheduler(): void {
  if (process.env.AUTO_TRADE_SCHEDULER === "off") return;
  // Dev reloads re-run instrumentation; one timer per process.
  const g = globalThis as { __autoTradeTimer?: ReturnType<typeof setInterval> };
  if (g.__autoTradeTimer) return;
  const port = process.env.PORT ?? "3200";
  // Auto mode and the paper account; each route decides whether anything is due.
  const urls = ["auto-trade", "paper"].map((r) => `http://127.0.0.1:${port}/api/cron/${r}`);
  const secret = process.env.CRON_SECRET;
  g.__autoTradeTimer = setInterval(() => {
    for (const url of urls) {
      fetch(url, { headers: secret ? { authorization: `Bearer ${secret}` } : {} }).catch(() => {
        /* server not ready yet, or restarting — next tick retries */
      });
    }
  }, TICK_MS);
  g.__autoTradeTimer.unref?.();
}
