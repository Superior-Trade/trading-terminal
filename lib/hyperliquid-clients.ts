import {
  InfoClient,
  SubscriptionClient,
  HttpTransport,
  WebSocketTransport,
} from "@nktkas/hyperliquid";

// terminal_v2 defaults to mainnet; set NEXT_PUBLIC_HL_NETWORK=Testnet to flip.
const isMainnet = process.env.NEXT_PUBLIC_HL_NETWORK !== "Testnet";

let httpTransport: HttpTransport | null = null;
let wsTransport: WebSocketTransport | null = null;
let infoClient: InfoClient | null = null;
let subscriptionClient: SubscriptionClient | null = null;

export function getHttpTransport(): HttpTransport {
  if (!httpTransport) {
    httpTransport = new HttpTransport({ isTestnet: !isMainnet });
  }
  return httpTransport;
}

export function getWebSocketTransport(): WebSocketTransport {
  if (!wsTransport) {
    wsTransport = new WebSocketTransport({ isTestnet: !isMainnet });
  }
  return wsTransport;
}

export function getInfoClient(): InfoClient {
  if (!infoClient) {
    infoClient = new InfoClient({ transport: getHttpTransport() });
  }
  return infoClient;
}

export function getSubscriptionClient(): SubscriptionClient {
  if (!subscriptionClient) {
    subscriptionClient = new SubscriptionClient({
      transport: getWebSocketTransport(),
    });
  }
  return subscriptionClient;
}
