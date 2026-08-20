import { TerminalShell } from "../components/terminal/terminal-shell";

// Pair deep-links (/BTC-USD, /XYZ-SNDK) arrive here via the next.config
// rewrite as ?pair=<slug>; the client resolves the slug once the market
// universe loads (PairSlugResolver keeps the pretty path in the URL bar).
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ pair?: string }>;
}) {
  const { pair } = await searchParams;
  return (
    <TerminalShell initialPairSlug={pair ? decodeURIComponent(pair) : undefined} />
  );
}
