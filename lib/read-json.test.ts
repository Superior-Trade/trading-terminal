import { describe, it, expect } from "vitest";
import {
  ResponseBodyError,
  bodySnippet,
  classifyBody,
  readJsonBody,
} from "./read-json";
import { responseFailureMessage } from "./setups-context";

// Verbatim from a production deploy failure: the terminal called /api/deploy,
// the platform answered with its own error page, and res.json() reported the
// first byte of that page as the reason the deploy failed.
const PLATFORM_ERROR_PAGE =
  "An error occurred with this application.\n\nNO_RESPONSE_FROM_FUNCTION\n";

const t = (k: string) =>
  k === "deployErrTimeout"
    ? "The server took too long to respond (HTTP {status})."
    : k === "deployErrUnavailable"
      ? "The service is temporarily unavailable (HTTP {status})."
      : k === "deployErrUnreadable"
        ? "The server returned an unreadable response (HTTP {status}). {detail}"
        : k;

describe("the failure this exists for", () => {
  it("reproduces the old message so the regression is visible", () => {
    // What users saw. The assertion is on the shape of the complaint, not our
    // code — if the runtime ever stops phrasing it this way, this comment is
    // the only record of what it used to say.
    expect(() => JSON.parse(PLATFORM_ERROR_PAGE)).toThrow(/not valid JSON/);
  });

  it("answers with the status instead of the first byte", async () => {
    const res = new Response(PLATFORM_ERROR_PAGE, { status: 504 });
    await expect(readJsonBody(res)).rejects.toThrow(ResponseBodyError);
    const err = await readJsonBody(
      new Response(PLATFORM_ERROR_PAGE, { status: 504 }),
    ).catch((e) => e as ResponseBodyError);
    expect(err.problem).toMatchObject({ status: 504, kind: "timeout" });
    expect(err.message).not.toContain("Unexpected token");
    expect(err.message).toContain("504");
  });
});

describe("readJsonBody", () => {
  it("passes valid JSON straight through", async () => {
    const res = new Response(JSON.stringify({ id: "dep_1" }), { status: 200 });
    await expect(readJsonBody<{ id: string }>(res)).resolves.toEqual({
      id: "dep_1",
    });
  });

  it("parses an error body, because the caller reads j.error", async () => {
    // A 400 with JSON is the validator-rejection path — it must NOT throw, or
    // the repair loop never sees the reasons.
    const res = new Response(
      JSON.stringify({ error: "validation_failed", details: ["bad stop"] }),
      { status: 400 },
    );
    await expect(readJsonBody<{ error: string }>(res)).resolves.toMatchObject({
      error: "validation_failed",
    });
  });

  it("treats an empty successful body as an empty object", async () => {
    await expect(
      readJsonBody(new Response(null, { status: 204 })),
    ).resolves.toEqual({});
  });

  it("treats an empty failure body as a failure, carrying its status", async () => {
    const err = await readJsonBody(new Response("", { status: 500 })).catch(
      (e) => e as ResponseBodyError,
    );
    expect(err).toBeInstanceOf(ResponseBodyError);
    expect(err.problem).toMatchObject({ status: 500, snippet: "" });
  });

  it("survives a body that cannot be read at all", async () => {
    const res = {
      status: 502,
      ok: false,
      text: () => Promise.reject(new Error("network error")),
    } as unknown as Response;
    const err = await readJsonBody(res).catch((e) => e as ResponseBodyError);
    expect(err).toBeInstanceOf(ResponseBodyError);
    expect(err.problem.status).toBe(502);
  });

  it("does not mistake a 200 that isn't JSON for a gateway failure", async () => {
    const err = await readJsonBody(
      new Response("<!doctype html><title>hi</title>", { status: 200 }),
    ).catch((e) => e as ResponseBodyError);
    expect(err.problem.kind).toBe("unreadable");
  });
});

describe("classifyBody", () => {
  it.each([
    [504, "timeout"],
    [524, "timeout"],
    [502, "unavailable"],
    [503, "unavailable"],
    [500, "unreadable"],
    [200, "unreadable"],
  ])("classifies %i as %s", (status, kind) => {
    expect(classifyBody(status, "whatever").kind).toBe(kind);
  });
});

describe("bodySnippet", () => {
  it("keeps the sentence and drops the markup", () => {
    expect(
      bodySnippet(
        "<html><head><style>b{color:red}</style></head><body><h1>502</h1><p>Bad gateway</p></body></html>",
      ),
    ).toBe("502 Bad gateway");
  });

  it("drops script contents rather than quoting them at the user", () => {
    expect(bodySnippet("<script>var a = 1;</script><p>Down</p>")).toBe("Down");
  });

  it("is bounded — an error page is not a card's worth of text", () => {
    const snip = bodySnippet("x".repeat(500));
    expect(snip.length).toBeLessThanOrEqual(121);
    expect(snip.endsWith("…")).toBe(true);
  });

  it("is empty when there was nothing but markup", () => {
    expect(bodySnippet("<div>   </div>")).toBe("");
  });
});

describe("responseFailureMessage", () => {
  it("says timed out for a 504, with no stray placeholder left behind", () => {
    const msg = responseFailureMessage(
      classifyBody(504, PLATFORM_ERROR_PAGE),
      t,
    );
    expect(msg).toBe("The server took too long to respond (HTTP 504).");
    expect(msg).not.toMatch(/\{(status|detail)\}/);
  });

  it("says unavailable for a 503", () => {
    expect(responseFailureMessage(classifyBody(503, ""), t)).toContain(
      "temporarily unavailable",
    );
  });

  it("quotes the excerpt when the status alone explains nothing", () => {
    const msg = responseFailureMessage(
      classifyBody(500, "<p>Backend unreachable</p>"),
      t,
    );
    expect(msg).toContain("HTTP 500");
    expect(msg).toContain("Backend unreachable");
  });
});
