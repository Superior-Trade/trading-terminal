import * as Sentry from "@sentry/nextjs";

import {
  beforeSendFilterLocalhost,
  getCurrentHostname,
  shouldEnableSentry,
} from "./lib/sentry-config";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: shouldEnableSentry(dsn, {
    hostname: getCurrentHostname(),
    nodeEnv: process.env.NODE_ENV,
  }),
  environment:
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
  tracesSampleRate: Number(
    process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0.1",
  ),
  replaysSessionSampleRate: Number(
    process.env.NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE ?? "0",
  ),
  replaysOnErrorSampleRate: Number(
    process.env.NEXT_PUBLIC_SENTRY_REPLAY_ERROR_SAMPLE_RATE ?? "1.0",
  ),
  beforeSend: beforeSendFilterLocalhost,
  beforeSendTransaction: beforeSendFilterLocalhost,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
