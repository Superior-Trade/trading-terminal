/** Boolean env flag: only "1"/"true" (case-insensitive) enable it. Bare
 *  presence is not enough — "0" and "false" must read as off, or a chart
 *  build someone disabled with FORCE_PREVIEW_CHART=0 stays disabled. */
export function envFlagEnabled(value: string | undefined): boolean {
  return /^(1|true)$/i.test((value ?? "").trim());
}
