import { describe, it, expect } from "vitest";
import { 
  buildTextPayload, 
  buildPostPayload
} from "../../src/feishu/payloads.js";

describe("Feishu Payload Builders", () => {
  it("builds text payload", () => {
    const payload = buildTextPayload("hello");
    expect(payload).toBe('{"text":"hello"}');
  });

  it("builds post payload", () => {
    const payload = buildPostPayload("Title", [["P1"], ["P2"]]);
    const obj = JSON.parse(payload);
    expect(obj.zh_cn.title).toBe("Title");
    expect(obj.zh_cn.content.length).toBe(2);
    expect(obj.zh_cn.content[0][0].text).toBe("P1");
  });
});
