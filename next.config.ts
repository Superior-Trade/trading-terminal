import path from "path";
import { existsSync } from "fs";
import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

// TradingView's Advanced Charts cannot be redistributed, so a fresh clone does
// not have it. Rather than fail the build, detect it here and let the app fall
// back to the Lightweight Charts preview. This is the only place that can make
// the call — the answer has to reach the browser, so it rides an env var, and
// the import path is aliased to a stub so the bundler still resolves it.
const CHARTS_DIR = path.join(process.cwd(), "public", "static", "charting_library");
const HAS_ADVANCED_CHARTS = existsSync(path.join(CHARTS_DIR, "charting_library.js"));

// Error monitoring is opt-in. Without SENTRY_ORG + SENTRY_PROJECT the config
// below is never applied, so a self-hosted build uploads nothing anywhere.
const sentryOrg = process.env.SENTRY_ORG?.trim();
const sentryProject = process.env.SENTRY_PROJECT?.trim();
const isVercelPreview =
  process.env.VERCEL === "1" && process.env.VERCEL_ENV !== "production";

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_HAS_ADVANCED_CHARTS: HAS_ADVANCED_CHARTS ? "1" : "0" },
  // Database drivers ship native bindings (pg) and a WASM payload (PGlite);
  // both must be required at runtime rather than walked by the bundler.
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
  // TradingView's widget lifecycle (iframe + async init) does not survive
  // StrictMode's dev double-mount: the second instance never resizes its
  // canvases. The production terminal app runs without StrictMode too.
  reactStrictMode: false,
  // Clean pair deep-links (/BTC-USD, /XYZ-SNDK) WITHOUT a dynamic [pair]
  // route segment: a dynamic segment makes Next spawn a static-paths worker
  // over the whole module graph, which crashed repeatedly in dev ("Jest
  // worker encountered 2 child process exceptions") and 500'd the route.
  // A rewrite keeps the pretty URL in the address bar and serves the root
  // page, which reads ?pair= server-side. The pattern only matches single
  // path segments made of letters/digits/hyphens, so /api, /_next and real
  // files (favicon.png etc.) with dots or slashes never match.
  async rewrites() {
    return [
      {
        source: "/:pair([A-Za-z0-9][A-Za-z0-9\\-]*)",
        destination: "/?pair=:pair",
      },
    ];
  },
  // Security response headers. Vercel adds none by default, and this app moves
  // real funds — so ship the zero-risk hardening headers now. NOTE: a full
  // resource CSP (script-src/connect-src/…) is intentionally NOT here: it must
  // be rolled out Content-Security-Policy-Report-Only first to enumerate the
  // TradingView / Privy / OpenRouter / Hyperliquid origins before enforcing,
  // or it will white-screen the terminal. What we ship here is safe because
  // `frame-ancestors` only governs who may frame US (anti-clickjacking) and
  // never affects what the page itself is allowed to load.
  async headers() {
    const securityHeaders = [
      // Force HTTPS for 2y incl. subdomains. `preload` is intentionally omitted
      // — submitting superior.trade to the HSTS preload list is a domain-wide,
      // hard-to-reverse commitment that's the operator's call, not a build-time
      // default. Add it once the apex is confirmed HTTPS-only and ready.
      {
        key: "Strict-Transport-Security",
        value: "max-age=63072000; includeSubDomains",
      },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      // Anti-clickjacking. X-Frame-Options for legacy UAs; CSP frame-ancestors
      // is the modern equivalent and is safe to enforce (see note above).
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
      // Deny powerful features we don't use. The voice-to-text feature needs
      // the microphone, so allow it for same-origin only; camera/geolocation
      // are unused, and browsing-topics opts out of the Topics API.
      {
        key: "Permissions-Policy",
        value:
          "camera=(), microphone=(self), geolocation=(), browsing-topics=()",
      },
    ];
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // Privy dynamically imports optional integrations we don't use (Stripe
  // fiat onramp, Farcaster mini-apps). Without stubs webpack prints a
  // "Module not found" warning pair on every compile. Alias to false =
  // empty module, warning gone, bundle a hair smaller.
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@stripe/crypto": false,
      "@farcaster/mini-app-solana": false,
      // Without the real library present, point its two import paths at a stub
      // so trading-chart.tsx still compiles. Nothing calls into it — the app
      // mounts the preview chart instead.
      ...(HAS_ADVANCED_CHARTS
        ? {}
        : {
            [path.join(CHARTS_DIR)]: path.join(process.cwd(), "components", "chart", "charting-library-stub.ts"),
            [path.join(CHARTS_DIR, "datafeed-api")]: path.join(process.cwd(), "components", "chart", "charting-library-stub.ts"),
          }),
    };
    return config;
  },
};

export default sentryOrg && sentryProject
  ? withSentryConfig(nextConfig, {
      org: sentryOrg,
      project: sentryProject,
      silent: !process.env.CI,
      sourcemaps: { disable: isVercelPreview },
      widenClientFileUpload: true,
      disableLogger: true,
    })
  : nextConfig;
