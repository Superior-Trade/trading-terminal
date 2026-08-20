/**
 * One timeline for the two kinds of setup a section can hold.
 *
 * Recurring deployments and one-shot direct orders come from different
 * endpoints, and the panel used to render them as two consecutive lists. That
 * ordered each section by TYPE first — every deployment, then every direct
 * order — so a one-shot placed minutes ago sorted below a deployment from last
 * week. Merging them here makes the order what a user actually reads it as:
 * newest first, regardless of which kind it is.
 */

export interface HasDeploymentTimestamps {
  /** The API returns camelCase; some paths still carry snake_case. */
  createdAt?: string;
  created_at?: string;
}

export interface HasBracketTimestamp {
  created_at?: string;
}

export type SetupRow<D, B> =
  | { kind: "dep"; at: number; item: D }
  | { kind: "brk"; at: number; b: B };

/** Epoch ms, or 0 when absent/unparseable so a row sorts last rather than
 *  throwing the whole list into NaN comparisons. */
export function setupTimestamp(value?: string | null): number {
  if (!value) return 0;
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}

export function orderSetupsNewestFirst<
  D extends HasDeploymentTimestamps,
  B extends HasBracketTimestamp,
>(deployments: D[], brackets: B[]): Array<SetupRow<D, B>> {
  const rows: Array<SetupRow<D, B>> = [
    ...deployments.map(
      (item): SetupRow<D, B> => ({
        kind: "dep",
        at: setupTimestamp(item.createdAt ?? item.created_at),
        item,
      }),
    ),
    ...brackets.map(
      (b): SetupRow<D, B> => ({ kind: "brk", at: setupTimestamp(b.created_at), b }),
    ),
  ];
  return rows.sort((a, z) => z.at - a.at);
}
