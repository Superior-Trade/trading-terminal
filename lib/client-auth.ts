"use client";

// Client-side auth plumbing. AuthBridge (in providers.tsx) registers
// Privy's getAccessToken here; every API call goes through authFetch so
// the Bearer rides along automatically. Without Privy configured, calls
// are anonymous and the server's dev-mode user takes over.

type TokenGetter = () => Promise<string | null>;

let tokenGetter: TokenGetter | null = null;

export function registerTokenGetter(getter: TokenGetter | null): void {
  tokenGetter = getter;
}

export async function authFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  let token: string | null = null;
  try {
    token = (await tokenGetter?.()) ?? null;
  } catch {
    /* token refresh failed — fall through anonymous */
  }
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}
