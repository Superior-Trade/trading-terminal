import * as Sentry from "@sentry/nextjs";

import {
  beforeSendFilterLocalhost,
  shouldEnableSentry,
} from "./lib/sentry-config";

const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: shouldEnableSentry(dsn, { nodeEnv: process.env.NODE_ENV }),
  environment:
    process.env.SENTRY_ENVIRONMENT ||
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ||
    process.env.NODE_ENV,
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
  beforeSend: beforeSendFilterLocalhost,
  beforeSendTransaction: beforeSendFilterLocalhost,
});
