import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  FEISHU_CARD_CALLBACK_PATH,
  createCardCallbackRequestHandler,
  createCardCallbackServer,
} from "../../src/feishu/card-callback-server.js";

describe("card callback server", () => {
  it("mounts the card handler on the exact /webhook/card path", () => {
    const requestHandler = vi.fn();
    const adaptDefaultImpl = vi.fn(() => requestHandler);
    const on = vi.fn();

    const result = createCardCallbackServer({
      cardActionHandler: { invoke: vi.fn() } as never,
      adaptDefaultImpl,
      createServerImpl: () => ({ on }),
    });

    expect(adaptDefaultImpl).toHaveBeenCalledWith(FEISHU_CARD_CALLBACK_PATH, {
      invoke: expect.any(Function),
    });
    expect(on).toHaveBeenCalledWith("request", expect.any(Function));
    expect(result.requestHandler).not.toBe(requestHandler);
  });

  it("normalizes query strings and rejects non-matching or non-post requests", async () => {
    const adaptedHandler = vi.fn(async (_req, res) => {
      res.statusCode = 200;
      res.end("ok");
    });
    const adaptDefaultImpl = vi.fn(() => adaptedHandler);

    const end = vi.fn();
    const handler = createCardCallbackRequestHandler(
      { invoke: vi.fn() } as never,
      adaptDefaultImpl,
    );

    await handler(
      {
        method: "POST",
        url: `${FEISHU_CARD_CALLBACK_PATH}?foo=bar`,
      } as never,
      { end, statusCode: 0 } as never,
    );

    expect(adaptedHandler).toHaveBeenCalledTimes(1);

    const notFoundEnd = vi.fn();
    await handler(
      { method: "POST", url: "/webhook/other" } as never,
      { end: notFoundEnd, statusCode: 0 } as never,
    );
    expect(notFoundEnd).toHaveBeenCalledWith("Not Found");

    const methodEnd = vi.fn();
    await handler(
      { method: "GET", url: FEISHU_CARD_CALLBACK_PATH } as never,
      { end: methodEnd, statusCode: 0 } as never,
    );
    expect(methodEnd).toHaveBeenCalledWith("Method Not Allowed");
  });

  it("exposes a request handler without requiring an ordinary event webhook route", () => {
    const requestHandler = vi.fn();
    const adaptDefaultImpl = vi.fn(() => requestHandler);

    const handler = createCardCallbackRequestHandler(
      { invoke: vi.fn() } as never,
      adaptDefaultImpl,
    );

    expect(adaptDefaultImpl).toHaveBeenCalledTimes(1);
    expect(adaptDefaultImpl).toHaveBeenCalledWith(FEISHU_CARD_CALLBACK_PATH, {
      invoke: expect.any(Function),
    });
    expect(handler).not.toBe(requestHandler);
  });

  it("rejects callbacks with invalid signature when verification is enabled", async () => {
    const adaptedHandler = vi.fn(async (_req, res) => {
      res.statusCode = 200;
      res.end("ok");
    });
    const adaptDefaultImpl = vi.fn(() => adaptedHandler);

    const handler = createCardCallbackRequestHandler(
      { invoke: vi.fn() } as never,
      adaptDefaultImpl,
      {
        verificationToken: "verification-token",
        encryptKey: "encrypt-key",
      },
    );

    const body = JSON.stringify({
      token: "verification-token",
      challenge: "x",
    });
    const req = Readable.from([body]) as Readable & Partial<IncomingMessage>;
    req.method = "POST";
    req.url = FEISHU_CARD_CALLBACK_PATH;
    req.headers = {
      "x-lark-request-timestamp": "1710000000",
      "x-lark-request-nonce": "nonce-1",
      "x-lark-request-signature": "invalid-signature",
    };

    const end = vi.fn();
    const res = { statusCode: 0, end };

    await handler(req as IncomingMessage, res as never);

    expect(adaptedHandler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(end).toHaveBeenCalledWith("Invalid signature");
  });

  it("passes callbacks with valid signature to adapted handler", async () => {
    const adaptedHandler = vi.fn(async (_req, res) => {
      res.statusCode = 200;
      res.end("ok");
    });
    const adaptDefaultImpl = vi.fn(() => adaptedHandler);

    const handler = createCardCallbackRequestHandler(
      { invoke: vi.fn() } as never,
      adaptDefaultImpl,
      {
        verificationToken: "verification-token",
        encryptKey: "encrypt-key",
      },
    );

    const timestamp = "1710000000";
    const nonce = "nonce-2";
    const body = JSON.stringify({
      token: "verification-token",
      challenge: "x",
    });
    const signature = createHash("sha256")
      .update(`${timestamp}${nonce}encrypt-key${body}`)
      .digest("hex");

    const req = Readable.from([body]) as Readable & Partial<IncomingMessage>;
    req.method = "POST";
    req.url = FEISHU_CARD_CALLBACK_PATH;
    req.headers = {
      "x-lark-request-timestamp": timestamp,
      "x-lark-request-nonce": nonce,
      "x-lark-request-signature": signature,
    };

    const end = vi.fn();
    const res = { statusCode: 0, end };

    await handler(req as IncomingMessage, res as never);

    expect(adaptedHandler).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledWith("ok");
  });
});
