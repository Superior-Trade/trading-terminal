import Link from "next/link";

// 404 — served for paths that don't resolve (the /:pair rewrite only catches
// single alnum segments, so real not-founds still land here). Renders inside
// the root layout, so app fonts/theme apply. Icon from the crystal-glass set
// (docs/icon-pipeline.md).
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-[#08090a] px-6 text-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/error/notfound.webp"
        alt=""
        className="h-40 w-40 select-none sm:h-48 sm:w-48"
        draggable={false}
      />
      <div className="flex flex-col items-center gap-2">
        <p className="font-mono text-[11px] uppercase tracking-widest text-lime-300">
          404
        </p>
        <h1 className="text-2xl font-semibold text-white">Page not found</h1>
        <p className="max-w-sm text-[13.5px] leading-relaxed text-white/55">
          This link is broken or the page has moved. Let&apos;s get you back to
          the chart.
        </p>
      </div>
      <Link
        href="/"
        className="rounded-full bg-lime-400 px-5 py-2 font-mono text-[11px] font-bold uppercase tracking-wider text-black transition-opacity hover:opacity-85"
      >
        Back to terminal
      </Link>
    </main>
  );
}
