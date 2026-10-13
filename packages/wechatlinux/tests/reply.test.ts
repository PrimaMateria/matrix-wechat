import { expect, test } from "bun:test";
import { XMLParser } from "fast-xml-parser";
import { replyXML } from "../src/reply";
import type { Message } from "../src/types";

const source: Message = {
  id: "9223372036854775806",
  account_id: "self",
  chat_id: "test@chatroom",
  chat_type: "group",
  sender_id: "friend",
  kind: "text",
  timestamp: 123,
  own: false,
  text: "<quoted> & text",
  native: { row: { local_type: 1 } },
};
test("quoted replies preserve exact source IDs and escape text without creating XML elements", () => {
  const parsed = new XMLParser({ parseTagValue: false }).parse(
    replyXML("</title><type>6</type>", source, "Friend & Co"),
  );
  const app = parsed.msg.appmsg;
  expect(app.type).toBe("57");
  expect(app.title).toBe("</title><type>6</type>");
  expect(app.refermsg.svrid).toBe(source.id);
  expect(app.refermsg.content).toBe(source.text);
  expect(app.refermsg.displayname).toBe("Friend & Co");
  expect(app.refermsg.chatusr).toBe(source.chat_id);
  expect(() => replyXML("reply", { ...source, id: "local:pending" }, "Friend")).toThrow();
  expect(() => replyXML("reply", { ...source, kind: "system" }, "Friend")).toThrow();
});
