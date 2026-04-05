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
      cardActionHandler: { invoke: vi.fn() },
      adaptDefaultImpl,
      createServerImpl: () => ({ on }),
    });

    expect(adaptDefaultImpl).toHaveBeenCalledWith(
      FEISHU_CARD_CALLBACK_PATH,
      { invoke: expect.any(Function) },
    );
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
      { invoke: vi.fn() },
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

    const handler = createCardCallbackRequestHandler({ invoke: vi.fn() }, adaptDefaultImpl);

    expect(adaptDefaultImpl).toHaveBeenCalledTimes(1);
    expect(adaptDefaultImpl).toHaveBeenCalledWith(
      FEISHU_CARD_CALLBACK_PATH,
      { invoke: expect.any(Function) },
    );
    expect(handler).not.toBe(requestHandler);
  });
});
