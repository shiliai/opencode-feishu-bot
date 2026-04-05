import { adaptDefault } from "@larksuiteoapi/node-sdk";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

export const FEISHU_CARD_CALLBACK_PATH = "/webhook/card";

export type RequestListener = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
type AdaptDefaultFn = typeof adaptDefault;
type CardCallbackDispatcher = Parameters<AdaptDefaultFn>[1];

export interface CardCallbackServerOptions {
  cardActionHandler: CardCallbackDispatcher;
  adaptDefaultImpl?: AdaptDefaultFn;
  createServerImpl?: () => Pick<Server, "on">;
}

export function createCardCallbackRequestHandler(
  cardActionHandler: CardCallbackDispatcher,
  adaptDefaultImpl: AdaptDefaultFn = adaptDefault,
): RequestListener {
  const adaptedHandler = adaptDefaultImpl(FEISHU_CARD_CALLBACK_PATH, cardActionHandler);

  return async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    if (requestUrl.pathname !== FEISHU_CARD_CALLBACK_PATH) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }

    if ((req.method ?? "GET").toUpperCase() !== "POST") {
      res.statusCode = 405;
      res.end("Method Not Allowed");
      return;
    }

    const originalUrl = req.url;
    req.url = FEISHU_CARD_CALLBACK_PATH;
    try {
      await adaptedHandler(req, res);
    } finally {
      req.url = originalUrl;
    }
  };
}

export function createCardCallbackServer(options: CardCallbackServerOptions): {
  requestHandler: RequestListener;
  server: Pick<Server, "on">;
} {
  const requestHandler = createCardCallbackRequestHandler(
    options.cardActionHandler,
    options.adaptDefaultImpl,
  );
  const server = (options.createServerImpl ?? createServer)();
  server.on("request", requestHandler);
  return { requestHandler, server };
}
