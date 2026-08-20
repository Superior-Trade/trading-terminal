"use client";

import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { useEffect } from "react";

// Route-level error boundary (the "500"). Renders inside the root layout, so
// app fonts/theme apply. Icon from the crystal-glass set (docs/icon-pipeline).
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-[#08090a] px-6 text-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/error/server.webp"
        alt=""
        className="h-40 w-40 select-none sm:h-48 sm:w-48"
        draggable={false}
      />
      <div className="flex flex-col items-center gap-2">
        <p className="font-mono text-[11px] uppercase tracking-widest text-red-300">
          Error
        </p>
        <h1 className="text-2xl font-semibold text-white">Something broke</h1>
        <p className="max-w-sm text-[13.5px] leading-relaxed text-white/55">
          An unexpected error interrupted the terminal. Your funds are safe. Try
          again, or head back to the chart.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={reset}
          className="cursor-pointer rounded-full bg-lime-400 px-5 py-2 font-mono text-[11px] font-bold uppercase tracking-wider text-black transition-opacity hover:opacity-85"
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded-full border border-white/15 px-5 py-2 font-mono text-[11px] font-bold uppercase tracking-wider text-white/60 transition-colors hover:border-white/30 hover:text-white"
        >
          Back to terminal
        </Link>
      </div>
    </main>
  );
}
