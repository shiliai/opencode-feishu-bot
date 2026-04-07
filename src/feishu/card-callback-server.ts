import { adaptDefault } from "@larksuiteoapi/node-sdk";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";

export const FEISHU_CARD_CALLBACK_PATH = "/webhook/card";

export type RequestListener = (
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;
type AdaptDefaultFn = typeof adaptDefault;
type CardCallbackDispatcher = Parameters<AdaptDefaultFn>[1];

export interface CardCallbackVerificationOptions {
  verificationToken?: string;
  encryptKey?: string;
}

export interface CardCallbackServerOptions {
  cardActionHandler: CardCallbackDispatcher;
  verification?: CardCallbackVerificationOptions;
  adaptDefaultImpl?: AdaptDefaultFn;
  createServerImpl?: () => Pick<Server, "on">;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getHeaderValue(req: IncomingMessage, key: string): string | null {
  const value = req.headers[key] ?? req.headers[key.toLowerCase()];
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : null;
  }
  return typeof value === "string" ? value : null;
}

function safeEqual(lhs: string, rhs: string): boolean {
  const lhsBuffer = Buffer.from(lhs, "utf-8");
  const rhsBuffer = Buffer.from(rhs, "utf-8");
  if (lhsBuffer.length !== rhsBuffer.length) {
    return false;
  }
  return timingSafeEqual(lhsBuffer, rhsBuffer);
}

function verifySignature(
  req: IncomingMessage,
  rawBody: string,
  options: CardCallbackVerificationOptions,
): boolean {
  const encryptKey = options.encryptKey?.trim();
  if (!encryptKey) {
    return true;
  }

  const timestamp = getHeaderValue(req, "x-lark-request-timestamp");
  const nonce = getHeaderValue(req, "x-lark-request-nonce");
  const signature =
    getHeaderValue(req, "x-lark-signature") ??
    getHeaderValue(req, "x-lark-request-signature");

  if (!timestamp || !nonce || !signature) {
    return false;
  }

  const expectedSignature = createHash("sha256")
    .update(`${timestamp}${nonce}${encryptKey}${rawBody}`)
    .digest("hex");

  return safeEqual(expectedSignature.toLowerCase(), signature.toLowerCase());
}

function verifyToken(
  rawBody: string,
  options: CardCallbackVerificationOptions,
): boolean {
  const expectedToken = options.verificationToken?.trim();
  if (!expectedToken) {
    return true;
  }

  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!isRecord(parsed)) {
      return false;
    }

    if (typeof parsed.token === "string") {
      return safeEqual(parsed.token, expectedToken);
    }

    if (typeof parsed.encrypt === "string") {
      // When an encrypted payload arrives, token verification is skipped —
      // the payload is authenticated by the signature check in verifySignature(),
      // which requires encryptKey to be configured. If encryptKey is absent
      // here, reject immediately (no bypass possible).
      return Boolean(options.encryptKey?.trim());
    }

    return false;
  } catch {
    return false;
  }
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer | string) => {
      chunks.push(
        typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk,
      );
    });
    req.on("error", reject);
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
  });
}

function createReplayRequest(
  req: IncomingMessage,
  rawBody: string,
): IncomingMessage {
  const replay = Readable.from([rawBody], { objectMode: false }) as Readable &
    Partial<IncomingMessage>;
  replay.headers = req.headers;
  replay.method = req.method;
  replay.url = req.url;
  return replay as IncomingMessage;
}

export function createCardCallbackRequestHandler(
  cardActionHandler: CardCallbackDispatcher,
  adaptDefaultImpl: AdaptDefaultFn = adaptDefault,
  verificationOptions: CardCallbackVerificationOptions = {},
): RequestListener {
  const adaptedHandler = adaptDefaultImpl(
    FEISHU_CARD_CALLBACK_PATH,
    cardActionHandler,
  );

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

    const shouldVerify =
      Boolean(verificationOptions.encryptKey) ||
      Boolean(verificationOptions.verificationToken);

    if (shouldVerify && typeof req.on === "function") {
      const rawBody = await readRawBody(req);
      if (!verifyToken(rawBody, verificationOptions)) {
        res.statusCode = 401;
        res.end("Invalid token");
        return;
      }

      if (!verifySignature(req, rawBody, verificationOptions)) {
        res.statusCode = 401;
        res.end("Invalid signature");
        return;
      }

      const replayReq = createReplayRequest(req, rawBody);
      replayReq.url = FEISHU_CARD_CALLBACK_PATH;
      await adaptedHandler(replayReq, res);
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
    options.verification,
  );
  const server = (options.createServerImpl ?? createServer)();
  server.on("request", requestHandler);
  return { requestHandler, server };
}
