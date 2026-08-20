// Render a markdown file exactly the way GitHub will, and open it in a browser.
//
//   npm run preview            # README.md
//   npm run preview docs/architecture.md
//
// Editor previews use their own markdown flavour and usually cannot resolve the
// repository-relative image paths, so a README full of screenshots looks empty
// in them. This posts the file to GitHub's own rendering API and writes the
// result to .preview.html at the repository root — which is why the relative
// <img src="docs/media/..."> paths resolve: the file sits where the README does.
//
// No token needed. The API allows 60 unauthenticated calls an hour, which is
// far more previewing than anyone does.
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const file = process.argv[2] ?? "README.md";
const markdown = readFileSync(file, "utf8");

const res = await fetch("https://api.github.com/markdown", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/vnd.github+json",
  },
  body: JSON.stringify({ text: markdown, mode: "gfm" }),
});

if (!res.ok) {
  console.error(
    `GitHub's markdown API returned ${res.status}. ${
      res.status === 403
        ? "That is the unauthenticated rate limit (60/hour) — wait a little."
        : ""
    }`,
  );
  process.exit(1);
}

const body = await res.text();

// Close enough to github.com to judge layout, spacing and whether an image
// lands where you meant it to. Both colour schemes, because the README is read
// in both.
const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${file} — preview</title>
<style>
  :root {
    color-scheme: light dark;
    --fg: #1f2328; --bg: #ffffff; --muted: #59636e; --border: #d1d9e0;
    --code-bg: #f6f8fa; --link: #0969da; --quote: #59636e;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fg: #f0f6fc; --bg: #0d1117; --muted: #9198a1; --border: #3d444d;
      --code-bg: #151b23; --link: #4493f8; --quote: #9198a1;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 16px 96px; background: var(--bg); color: var(--fg);
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
  }
  .wrap { max-width: 1012px; margin: 0 auto; }
  .bar {
    max-width: 1012px; margin: 0 auto 24px; padding: 8px 16px; border-radius: 6px;
    border: 1px solid var(--border); background: var(--code-bg);
    font: 12px/1.5 ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; color: var(--muted);
  }
  .md { border: 1px solid var(--border); border-radius: 6px; padding: 32px 40px; }
  .md > *:first-child { margin-top: 0; }
  h1, h2 { padding-bottom: .3em; border-bottom: 1px solid var(--border); margin: 24px 0 16px; line-height: 1.25; }
  h1 { font-size: 2em; } h2 { font-size: 1.5em; } h3 { font-size: 1.25em; margin: 24px 0 16px; }
  p, ul, ol, table, pre, blockquote { margin: 0 0 16px; }
  a { color: var(--link); text-decoration: none; } a:hover { text-decoration: underline; }
  img { max-width: 100%; border-radius: 6px; }
  code {
    background: var(--code-bg); padding: .2em .4em; border-radius: 6px; font-size: 85%;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  }
  pre { background: var(--code-bg); padding: 16px; border-radius: 6px; overflow-x: auto; }
  pre code { background: none; padding: 0; font-size: 100%; }
  table { border-collapse: collapse; display: block; overflow-x: auto; width: max-content; max-width: 100%; }
  th, td { border: 1px solid var(--border); padding: 6px 13px; }
  tr:nth-child(2n) { background: var(--code-bg); }
  blockquote { padding: 0 1em; color: var(--quote); border-left: .25em solid var(--border); }
  .markdown-alert {
    padding: 8px 16px; margin-bottom: 16px; border-left: .25em solid var(--border); border-radius: 6px;
  }
  .markdown-alert-important { border-left-color: #8250df; }
  .markdown-alert-title { font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .markdown-alert > :last-child { margin-bottom: 0; }
  hr { height: .25em; background: var(--border); border: 0; margin: 24px 0; }
</style>
</head>
<body>
  <div class="bar">Preview of <strong>${file}</strong> — rendered by GitHub's own API. Images load from disk, so what you see is what the repository will show.</div>
  <div class="wrap"><div class="md">${body}</div></div>
</body>
</html>`;

const out = join(process.cwd(), ".preview.html");
writeFileSync(out, page, "utf8");
console.log(`\n  ${out}\n`);

const opener =
  process.platform === "win32"
    ? ["cmd", ["/c", "start", "", out]]
    : process.platform === "darwin"
      ? ["open", [out]]
      : ["xdg-open", [out]];
spawn(opener[0], opener[1], { detached: true, stdio: "ignore" }).unref();
