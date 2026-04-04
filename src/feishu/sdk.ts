import {
  Client,
  WSClient,
  CardActionHandler,
  Domain,
} from "@larksuiteoapi/node-sdk";
import type { AppConfig } from "../config.js";

export interface FeishuClients {
  client: Client;
  wsClient: WSClient;
  cardActionHandler: CardActionHandler | null;
}

const EMPTY_CARD_HANDLER: (...args: unknown[]) => unknown = () =>
  Promise.resolve();

export function createFeishuClients(
  config: AppConfig,
  cardHandler: ((...args: unknown[]) => unknown) | undefined = undefined,
): FeishuClients {
  const domain = Domain.Feishu;

  const client = new Client({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    domain,
  });

  const wsClient = new WSClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    domain,
    autoReconnect: true,
  });

  let cardActionHandler: CardActionHandler | null = null;
  if (config.connectionType === "webhook" && config.cardCallback) {
    cardActionHandler = new CardActionHandler(
      {
        verificationToken: config.cardCallback.verificationToken,
        encryptKey: config.cardCallback.encryptKey,
      },
      cardHandler ?? EMPTY_CARD_HANDLER,
    );
  }

  return { client, wsClient, cardActionHandler };
}
