"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

// Ultimate fallback: fires only when the ROOT LAYOUT itself throws, so it
// replaces <html>/<body> and cannot rely on the app's fonts or CSS — styles
// are inlined and self-sufficient.
export default function GlobalError({
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
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "24px",
          padding: "24px",
          textAlign: "center",
          background: "#08090a",
          color: "#fff",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/error/server.webp"
          alt=""
          width={176}
          height={176}
          draggable={false}
          style={{ userSelect: "none" }}
        />
        <h1 style={{ fontSize: "22px", fontWeight: 600, margin: 0 }}>
          Something broke
        </h1>
        <p
          style={{
            maxWidth: "24rem",
            fontSize: "13.5px",
            lineHeight: 1.6,
            color: "rgba(255,255,255,0.55)",
            margin: 0,
          }}
        >
          An unexpected error interrupted the terminal. Your funds are safe.
        </p>
        <button
          onClick={reset}
          style={{
            cursor: "pointer",
            border: 0,
            borderRadius: "9999px",
            background: "#a3e635",
            color: "#000",
            padding: "8px 20px",
            fontSize: "11px",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
