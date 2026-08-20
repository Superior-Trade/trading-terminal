import { after } from "next/server";

/* Product analytics — optional, off by default.
 *
 * Every tracked user action is forwarded to PostHog when POSTHOG_KEY is set.
 * With no key the whole module is a no-op: nothing is sent anywhere, no
 * network call is made, and self-hosted installs stay entirely offline.
 *
 * Fire-and-forget like strategy-log: analytics must NEVER slow down or break
 * the request. Delivery rides Next's after() so it completes once the
 * response has flushed.
 */

export type TrackProps = Record<
  string,
  string | number | boolean | null | undefined
>;

const POSTHOG_KEY = (process.env.POSTHOG_KEY ?? "").trim();
const POSTHOG_HOST = (
  process.env.POSTHOG_HOST ?? "https://us.i.posthog.com"
).replace(/\/+$/, "");

async function sendPosthog(
  event: string,
  distinctId: string,
  props: TrackProps,
): Promise<void> {
  if (!POSTHOG_KEY) return;
  // First-touch acquisition (ft_*) → $set_once so the FIRST value sticks to
  // the person and every later login/deposit/deploy is attributed to the
  // source that brought them, not to whatever page they were last on.
  const setOnce: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("ft_") && v != null && v !== "") setOnce[k] = v;
  }
  const email = props.email;
  const wallet = props.wallet;
  const set = { ...(email ? { email } : {}), ...(wallet ? { wallet } : {}) };
  const person = {
    ...(Object.keys(set).length ? { $set: set } : {}),
    ...(Object.keys(setOnce).length ? { $set_once: setOnce } : {}),
  };
  await fetch(`${POSTHOG_HOST}/i/v0/e/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: POSTHOG_KEY,
      event,
      distinct_id: distinctId,
      properties: { ...props, source: "trading-terminal", ...person },
      timestamp: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(5000),
  });
}

/** Debug path (used by /api/track { debug } only): run the sink inline and
 *  report the outcome, so an operator can see WHY delivery fails without
 *  access to server logs. */
export async function trackFlush(
  event: string,
  opts: { user?: string | null; props?: TrackProps } = {},
): Promise<Record<string, string>> {
  if (!POSTHOG_KEY) return { posthog: "disabled (POSTHOG_KEY unset)" };
  const [result] = await Promise.allSettled([
    sendPosthog(event, opts.user ?? "server", opts.props ?? {}),
  ]);
  return {
    posthog:
      result.status === "fulfilled"
        ? "ok"
        : String((result as PromiseRejectedResult).reason),
  };
}

/** Fire-and-forget: record one user action. `user` is the account id; missing
 *  → "server". Safe to call from any server context — errors are swallowed,
 *  nothing is awaited by the caller. */
export function track(
  event: string,
  opts: { user?: string | null; props?: TrackProps } = {},
): void {
  if (!POSTHOG_KEY) return;
  const job = () =>
    sendPosthog(event, opts.user ?? "server", opts.props ?? {}).catch(
      () => undefined,
    );
  try {
    // after(): delivery continues once the response has flushed (a serverless
    // host would otherwise freeze the function mid-send).
    after(job);
  } catch {
    void job(); // outside request scope (rare) — best effort
  }
}
