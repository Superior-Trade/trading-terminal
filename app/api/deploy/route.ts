import { NextResponse } from "next/server";
import { resolveSuperiorAuth } from "../../../lib/superior-key";
import { deployStrategy } from "../../../lib/superior-api";
import { track } from "../../../lib/analytics";
import { fundsFrozen } from "../../../lib/kill-switch";
import { normalizeConfigPairs } from "../../../lib/pair-normalize";

export const runtime = "nodejs";
// Allocate-on-deploy (#903) moved the on-chain funding of the trading account
// (a Privy-sponsored USDC transfer + Arbitrum confirmation, ~15-30s) INTO the
// deploy's start step. That pushes this request past Vercel's ~10-15s default
// function timeout, so the function was killed mid-flight — the UI hung on
// "Creating deployment…" and the deploy appeared stuck. Give it the same
// generous ceiling as the other long routes (chat=300, compile=120).
export const maxDuration = 300;

// Creates a live deployment from an agent-compiled strategy, provisions
// credentials, and starts it (lib/superior-api). Returns per-step status
// codes + upstream error messages so the UI reports exactly how far it got.
export async function POST(req: Request) {
  const frozen = fundsFrozen("trade");
  if (frozen) return frozen;
  let apiKey: string;
  let userDid: string;
  try {
    const auth = await resolveSuperiorAuth(req);
    apiKey = auth.key;
    userDid = auth.user.did;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  try {
    const body = await req.json();
    // Last-line pair normalization before funds move: any deploy path (compile,
    // redeploy, restart, a hand-built config) gets its pair_whitelist forced to
    // canonical HL perp symbols. A malformed pair ("HYPE/USD:USD") otherwise
    // makes freqtrade drop the market and idle a funded wallet.
    const bodyCfg = (body as { config?: Record<string, unknown> })?.config;
    if (bodyCfg) normalizeConfigPairs(bodyCfg);
    // Hyperliquid's $10 minimum order value: a numeric stake below it can
    // never fill, so the bot would spin doing nothing. ("unlimited" and
    // missing stakes size off wallet balance — those pass through.)
    const stake = (body as { config?: { stake_amount?: unknown } })?.config
      ?.stake_amount;
    if (typeof stake === "number" && stake < 10) {
      return NextResponse.json(
        {
          error:
            "stake_amount below the $10 Hyperliquid minimum order value — raise the funding to at least 10 USDC",
        },
        { status: 400 },
      );
    }
    const { status, json, steps, stepErrors } = await deployStrategy(
      apiKey,
      body,
    );
    const cfg = (body as { config?: Record<string, unknown> })?.config ?? {};
    const detail = {
      name:
        typeof (body as { name?: unknown })?.name === "string"
          ? (body as { name: string }).name
          : undefined,
      pair: (cfg.exchange as { pair_whitelist?: string[] } | undefined)
        ?.pair_whitelist?.[0],
      stake:
        typeof cfg.stake_amount === "number" || typeof cfg.stake_amount === "string"
          ? cfg.stake_amount
          : undefined,
      timeframe: typeof cfg.timeframe === "string" ? cfg.timeframe : undefined,
      mode: typeof (body as { mode?: unknown })?.mode === "string"
        ? (body as { mode: string }).mode
        : undefined,
    };
    if (!steps.create || steps.create >= 400) {
      track("deploy_failed", {
        user: userDid,
        props: {
          ...detail,
          status,
          step: "create",
          error: String(
            (json as { message?: unknown; error?: unknown }).message ??
              (json as { error?: unknown }).error ??
              "",
          ).slice(0, 300),
        },
      });
      return NextResponse.json(json, { status });
    }
    const started = !Object.keys(stepErrors).length;
    track(started ? "deploy_success" : "deploy_failed", {
      user: userDid,
      props: {
        ...detail,
        status,
        deploymentId: (json as { id?: string }).id,
        ...(started
          ? {}
          : {
              step: Object.keys(stepErrors).join(","),
              error: Object.values(stepErrors).join("; ").slice(0, 300),
            }),
      },
    });
    return NextResponse.json({
      ...json,
      steps,
      ...(Object.keys(stepErrors).length ? { stepErrors } : {}),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "deploy proxy error" },
      { status: 502 },
    );
  }
}
