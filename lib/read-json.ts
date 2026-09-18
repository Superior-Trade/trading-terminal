/**
 * Read a JSON response body without assuming the body is JSON.
 *
 * `res.json()` on a platform error page — a gateway timeout, a cold start that
 * never finished, an upstream 502 — throws
 * `Unexpected token 'A', "An error o"... is not valid JSON`. That string named
 * the first byte of an HTML error page instead of the failure, so a timeout
 * and a bug were indistinguishable to the person reading the card, and to us
 * reading the failure analytics.
 *
 * The status code is the part worth keeping, so it is carried on the thrown
 * error and rendered through i18n at the call site.
 */

export type ResponseBodyProblem = {
  status: number;
  kind: "timeout" | "unavailable" | "unreadable";
  /** A short, tag-stripped excerpt of whatever did arrive. May be empty. */
  snippet: string;
};

const SNIPPET_CHARS = 120;

export class ResponseBodyError extends Error {
  readonly problem: ResponseBodyProblem;

  constructor(problem: ResponseBodyProblem) {
    super(defaultMessage(problem));
    this.name = "ResponseBodyError";
    this.problem = problem;
  }
}

/** Whatever arrived, reduced to one readable line. HTML error pages are the
 *  common case, and their markup is noise — the sentence inside is not. */
export function bodySnippet(body: string): string {
  const text = body
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length > SNIPPET_CHARS
    ? `${text.slice(0, SNIPPET_CHARS).trimEnd()}…`
    : text;
}

export function classifyBody(
  status: number,
  body: string,
): ResponseBodyProblem {
  const snippet = bodySnippet(body);
  // 524 is Cloudflare's own origin timeout; it reaches the browser as a
  // status no fetch of ours ever sets deliberately.
  const kind =
    status === 504 || status === 524
      ? "timeout"
      : status === 502 || status === 503
        ? "unavailable"
        : "unreadable";
  return { status, kind, snippet };
}

function defaultMessage(problem: ResponseBodyProblem): string {
  const lead =
    problem.kind === "timeout"
      ? "The server took too long to respond"
      : problem.kind === "unavailable"
        ? "The service is temporarily unavailable"
        : "The server returned an unreadable response";
  const head = `${lead} (HTTP ${problem.status})`;
  return problem.snippet ? `${head}: ${problem.snippet}` : `${head}.`;
}

/**
 * Parse `res` as JSON, or throw a {@link ResponseBodyError} describing what
 * actually came back. An empty body on a successful response is `{}` — a 204
 * belongs on the caller's normal path, not in a catch. An empty body on a
 * failure is a failure with nothing in it but its status, which is exactly
 * what the error carries.
 */
export async function readJsonBody<T>(res: Response): Promise<T> {
  let body: string;
  try {
    body = await res.text();
  } catch {
    throw new ResponseBodyError(classifyBody(res.status, ""));
  }
  if (!body.trim()) {
    if (res.ok) return {} as T;
    throw new ResponseBodyError(classifyBody(res.status, ""));
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new ResponseBodyError(classifyBody(res.status, body));
  }
}
