"use client";

// Dev-only visual harness for the PnL share card (mock data, all states).
// Not linked anywhere; exists so card changes can be eyeballed without
// waiting for a deployment to accumulate fills.

import { useState } from "react";
import { PnlShareCard } from "../../../components/terminal/pnl-share-card";
import { I18nProvider } from "../../../lib/i18n";
import { HyperliquidProvider } from "../../../lib/hyperliquid-provider";

const TRADES = [
  { t: Date.now() - 30 * 60000, coin: "SNDK", dir: "long" as const, pnl: 0, realized: false, px: 1418 },
  { t: Date.now() - 5 * 3600_000, coin: "SNDK", dir: "long" as const, pnl: 12.4, realized: true, px: 1440 },
  { t: Date.now() - 9 * 3600_000, coin: "SNDK", dir: "short" as const, pnl: -3.1, realized: true, px: 1395 },
  { t: Date.now() - 26 * 3600_000, coin: "SNDK", dir: "long" as const, pnl: 31.05, realized: true, px: 1372 },
  { t: Date.now() - 50 * 3600_000, coin: "SNDK", dir: "long" as const, pnl: 8.7, realized: true, px: 1350 },
];

const WIN = {
  strategyName: "VWAP回歸做多動能追蹤",
  pair: "xyz:SNDK",
  direction: "long" as const,
  leverage: 10,
  stake: 300,
  totalPnl: 87.42,
  unrealizedPnl: 14.3,
  tradeCount: 14,
  startedAt: Date.now() - 3 * 86400_000 - 5 * 3600_000,
  points: Array.from({ length: 40 }, (_, i) => ({
    t: i,
    v: Math.sin(i / 6) * 12 + i * 2.2 + (i % 7) * 1.5,
  })),
  trades: TRADES,
};

const LOSS = {
  ...WIN,
  strategyName: "Breakout fade — failed retest",
  pair: "BTC-USD",
  direction: "short" as const,
  totalPnl: -41.1,
  unrealizedPnl: -6.2,
  tradeCount: 6,
  points: Array.from({ length: 40 }, (_, i) => ({
    t: i,
    v: Math.sin(i / 5) * 8 - i * 1.1,
  })),
  trades: TRADES.map((tr) => ({ ...tr, coin: "BTC", pnl: -tr.pnl })),
};

export default function DevPnlCard() {
  const [which, setWhich] = useState<"win" | "loss" | null>("win");
  if (process.env.NODE_ENV === "production") return null;
  return (
    <HyperliquidProvider>
    <I18nProvider>
      <div className="flex h-dvh items-center justify-center gap-3 bg-black">
        <button className="rounded bg-lime-400 px-4 py-2 font-mono text-black" onClick={() => setWhich("win")}>
          win card
        </button>
        <button className="rounded bg-red-400 px-4 py-2 font-mono text-black" onClick={() => setWhich("loss")}>
          loss card
        </button>
        {which && (
          <PnlShareCard data={which === "win" ? WIN : LOSS} onClose={() => setWhich(null)} />
        )}
      </div>
    </I18nProvider>
    </HyperliquidProvider>
  );
}
