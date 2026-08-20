type SentryRequestLike = {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
};

type SentryFrameLike = {
  filename?: string;
  absPath?: string;
  module?: string;
  inApp?: boolean;
};

type SentrySpanLike = {
  op?: string;
  description?: string;
  data?: Record<string, unknown>;
};

type SentryExceptionLike = {
  values?: Array<{
    type?: string;
    value?: string;
    stacktrace?: {
      frames?: SentryFrameLike[];
    } | null;
    mechanism?: {
      type?: string;
    };
  }>;
};

type SentryEventLike = {
  type?: string;
  request?: SentryRequestLike;
  exception?: SentryExceptionLike;
  spans?: SentrySpanLike[];
};

type SentryEnableOptions =
  | string
  | {
      hostname?: string | null;
      nodeEnv?: string;
    };

function normalizeHostname(host: string): string {
  const trimmed = host.trim().toLowerCase().replace(/\.$/, "");

  if (trimmed.startsWith("[") && trimmed.includes("]")) {
    return trimmed.slice(1, trimmed.indexOf("]"));
  }

  const colonCount = (trimmed.match(/:/g) ?? []).length;
  if (colonCount === 1) {
    return trimmed.split(":")[0] ?? "";
  }

  return trimmed;
}

export function isLocalhostHost(host?: string | null): boolean {
  if (!host) return false;

  const normalized = normalizeHostname(host);

  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized === "0.0.0.0" ||
    normalized === "127.0.0.1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function getUrlHostname(url?: string): string | undefined {
  if (!url) return undefined;

  try {
    return new URL(url).hostname;
  } catch {
    try {
      return new URL(`http://${url}`).hostname;
    } catch {
      return undefined;
    }
  }
}

function getUrlPathname(url?: string): string | undefined {
  if (!url) return undefined;

  try {
    return new URL(url).pathname;
  } catch {
    try {
      return new URL(
        `http://placeholder${url.startsWith("/") ? "" : "/"}${url}`,
      ).pathname;
    } catch {
      return undefined;
    }
  }
}

function getHeaderValue(
  headers: SentryRequestLike["headers"],
  name: string,
): string | undefined {
  const entry = Object.entries(headers ?? {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  const value = entry?.[1];

  return Array.isArray(value) ? value[0] : value;
}

export function getCurrentHostname(): string | undefined {
  return globalThis.location?.hostname;
}

export function shouldEnableSentry(
  dsn?: string,
  options: SentryEnableOptions = {},
): boolean {
  if (!dsn) return false;

  const hostname = typeof options === "string" ? options : options.hostname;
  const nodeEnv = typeof options === "string" ? undefined : options.nodeEnv;

  if (nodeEnv === "development") return false;

  return !isLocalhostHost(hostname);
}

export function beforeSendFilterLocalhost<T extends SentryEventLike>(
  event: T,
): T | null {
  if (isKnownSentryJsonCycleNoise(event)) {
    return null;
  }

  if (isKnownBrowserExtensionNoise(event)) {
    return null;
  }

  if (isKnownExpectedBrowserAbortNoise(event)) {
    return null;
  }

  if (isKnownWalletProviderNoise(event)) {
    return null;
  }

  if (isKnownBotMissingServerActionNoise(event)) {
    return null;
  }

  if (isKnownMalformedServerActionFormNoise(event)) {
    return null;
  }

  if (isKnownStacklessBrowserRejectionNoise(event)) {
    return null;
  }

  if (isKnownReactDomMutationNoise(event)) {
    return null;
  }

  if (isKnownHyperliquidLargePayloadTransaction(event)) {
    return null;
  }

  if (isLocalhostHost(getUrlHostname(event.request?.url))) {
    return null;
  }

  if (isLocalhostHost(getHeaderValue(event.request?.headers, "host"))) {
    return null;
  }

  return event;
}

function isKnownSentryJsonCycleNoise(event: SentryEventLike): boolean {
  return (
    event.exception?.values?.some(
      (exception) =>
        exception.type === "TypeError" &&
        exception.value ===
          "JSON.stringify cannot serialize cyclic structures." &&
        exception.mechanism?.type ===
          "auto.browser.browserapierrors.setTimeout",
    ) ?? false
  );
}

function isKnownBrowserExtensionNoise(event: SentryEventLike): boolean {
  return (
    event.exception?.values?.some((exception) => {
      const frames = exception.stacktrace?.frames ?? [];

      if (
        exception.type === "RangeError" &&
        exception.value === "Maximum call stack size exceeded" &&
        frames.some(isKnownBrowserExtensionFrame)
      ) {
        return true;
      }

      if (
        (exception.value === "Failed to connect to MetaMask" ||
          exception.value === "MetaMask extension not found") &&
        frames.some(isMetaMaskInpageFrame)
      ) {
        return true;
      }

      if (
        exception.type === "Error" &&
        exception.value === "func sseError not found" &&
        exception.mechanism?.type ===
          "auto.browser.global_handlers.onunhandledrejection" &&
        frames.some(isWalletInpageFrame)
      ) {
        return true;
      }

      return false;
    }) ?? false
  );
}

function isKnownExpectedBrowserAbortNoise(event: SentryEventLike): boolean {
  return (
    event.exception?.values?.some((exception) => {
      const frames = exception.stacktrace?.frames ?? [];

      return (
        exception.type === "AbortError" &&
        exception.value === "signal is aborted without reason" &&
        exception.mechanism?.type ===
          "auto.browser.global_handlers.onunhandledrejection" &&
        frames.length > 0 &&
        !frames.some(
          (frame) =>
            frame.inApp === true &&
            !isReactDomFrame(frame) &&
            !isKnownBrowserExtensionFrame(frame),
        )
      );
    }) ?? false
  );
}

function isKnownWalletProviderNoise(event: SentryEventLike): boolean {
  return (
    event.exception?.values?.some((exception) => {
      const frames = exception.stacktrace?.frames ?? [];

      if (
        exception.type === "Error" &&
        exception.value ===
          "Talisman extension has not been configured yet. Please continue with onboarding." &&
        frames.some((frame) => {
          const source = getFrameSource(frame);
          return isWalletInpageFrame(frame) || source.includes("app:///page.js");
        })
      ) {
        return true;
      }

      if (
        exception.type === "Error" &&
        exception.value ===
          "WebSocket connection failed for host: wss://relay.walletconnect.org" &&
        frames.some((frame) =>
          getFrameSource(frame).includes("@walletconnect/jsonrpc-ws-connection"),
        )
      ) {
        return true;
      }

      return false;
    }) ?? false
  );
}

function isKnownBotMissingServerActionNoise(event: SentryEventLike): boolean {
  if (!isMissingServerActionError(event)) return false;

  const requestPath = getUrlPathname(event.request?.url);
  const matchedPath = getHeaderValue(event.request?.headers, "x-matched-path");
  const nextErrorStatus = getHeaderValue(
    event.request?.headers,
    "x-next-error-status",
  );

  return (
    event.request?.method === "POST" &&
    matchedPath === "/_not-found" &&
    nextErrorStatus === "404" &&
    isKnownScannerPath(requestPath)
  );
}

function isKnownMalformedServerActionFormNoise(
  event: SentryEventLike,
): boolean {
  return (
    event.request?.method === "POST" &&
    (event.exception?.values?.some((exception) => {
      const frames = exception.stacktrace?.frames ?? [];

      return (
        exception.type === "TypeError" &&
        exception.value === "Failed to parse body as FormData." &&
        frames.length > 0 &&
        !frames.some((frame) => frame.inApp === true)
      );
    }) ??
      false)
  );
}

function isKnownStacklessBrowserRejectionNoise(
  event: SentryEventLike,
): boolean {
  return (
    event.exception?.values?.some((exception) => {
      const frames = exception.stacktrace?.frames ?? [];
      const message = exception.value?.trim() ?? "";

      return (
        exception.type === "Error" &&
        exception.mechanism?.type ===
          "auto.browser.global_handlers.onunhandledrejection" &&
        frames.length === 0 &&
        /^[a-z]{1,3}$/.test(message)
      );
    }) ?? false
  );
}

function isMissingServerActionError(event: SentryEventLike): boolean {
  return (
    event.exception?.values?.some(
      (exception) =>
        exception.type === "Error" &&
        exception.mechanism?.type === "auto.function.nextjs.on_request_error" &&
        exception.value?.startsWith("Failed to find Server Action.") === true,
    ) ?? false
  );
}

function isKnownScannerPath(path?: string): boolean {
  if (!path) return false;

  const normalized = path.toLowerCase();

  return (
    normalized.startsWith("/cf_scripts/") ||
    normalized.includes("/ckeditor/") ||
    normalized.includes("/filemanager/") ||
    normalized.startsWith("/wp-") ||
    normalized.includes("/wp-content/") ||
    normalized.includes("/wp-includes/") ||
    normalized === "/xmlrpc.php" ||
    normalized.includes("/phpmyadmin") ||
    normalized.includes("/vendor/phpunit/") ||
    normalized.includes("/.env") ||
    normalized.endsWith(".cfm") ||
    normalized.endsWith(".php")
  );
}

function isKnownReactDomMutationNoise(event: SentryEventLike): boolean {
  return (
    event.exception?.values?.some((exception) => {
      const frames = exception.stacktrace?.frames ?? [];

      if (
        exception.type !== "NotFoundError" ||
        !isReactDomMutationErrorMessage(exception.value) ||
        !frames.some(isReactDomFrame)
      ) {
        return false;
      }

      return !frames.some(
        (frame) =>
          frame.inApp === true &&
          !isReactDomFrame(frame) &&
          !isKnownBrowserExtensionFrame(frame),
      );
    }) ?? false
  );
}

function isKnownHyperliquidLargePayloadTransaction(
  event: SentryEventLike,
): boolean {
  if (event.type !== "transaction") return false;

  return (
    event.spans?.some((span) => {
      const responseContentLength = getNumericSpanData(
        span,
        "http.response_content_length",
      );
      const url = getStringSpanData(span, "http.url") ?? span.description ?? "";
      const method = getStringSpanData(span, "http.request_method");

      return (
        span.op === "http.client" &&
        method === "POST" &&
        url === "https://api.hyperliquid.xyz/info" &&
        responseContentLength >= 50_000
      );
    }) ?? false
  );
}

function isReactDomMutationErrorMessage(value?: string): boolean {
  return (
    value ===
      "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node." ||
    value ===
      "Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node."
  );
}

function isKnownBrowserExtensionFrame(frame: SentryFrameLike): boolean {
  const source = getFrameSource(frame);

  return (
    source.includes("app:///injectLeap.js") ||
    source.includes("app:///inject.chrome.") ||
    source.includes("chrome-extension://")
  );
}

function isMetaMaskInpageFrame(frame: SentryFrameLike): boolean {
  const source = getFrameSource(frame);

  return (
    source.includes("app:///scripts/inpage.js") ||
    source.includes("chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/")
  );
}

function isWalletInpageFrame(frame: SentryFrameLike): boolean {
  const source = getFrameSource(frame);

  return (
    source.includes("app:///inpage.js") ||
    source.includes("app:///scripts/inpage.js") ||
    source.includes("chrome-extension://")
  );
}

function isReactDomFrame(frame: SentryFrameLike): boolean {
  const source = getFrameSource(frame);

  return source.includes("react-dom-client") || source.includes("/react-dom/");
}

function getFrameSource(frame: SentryFrameLike): string {
  return [frame.filename, frame.absPath, frame.module]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

function getStringSpanData(
  span: SentrySpanLike,
  key: string,
): string | undefined {
  const value = span.data?.[key];

  return typeof value === "string" ? value : undefined;
}

function getNumericSpanData(span: SentrySpanLike, key: string): number {
  const value = span.data?.[key];

  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);

  return 0;
}
