"use client";

// Every API call in the UI goes through authFetch. It used to attach a bearer
// token; there is no login now, so it is a plain fetch — kept as one function
// so that adding a credential later (a hosted build, a proxy that needs a
// header) is a change in one file rather than in nineteen.

export async function authFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(input, init);
}
