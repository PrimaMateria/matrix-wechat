import { APIError, type Message } from "./types";

const escapeXML = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character]!,
  );

export function replyXML(text: string, message: Message, displayName: string) {
  if (!/^\d{1,20}$/.test(message.id) || message.id === "0" || !message.sender_id)
    throw new APIError("invalid_params", "This message cannot be quoted yet");
  const type = Number(message.native?.row.local_type) % 4294967296;
  if (!Number.isInteger(type) || message.kind === "system")
    throw new APIError("invalid_params", "This message cannot be quoted");
  const content = message.text ?? message.native?.decoded_content ?? `[${message.kind}]`;
  const from = message.chat_id === "filehelper" ? "filehelper" : message.sender_id;
  const context =
    message.chat_type === "group"
      ? message.chat_id
      : message.chat_id === "filehelper"
        ? message.account_id
        : message.chat_id;
  const xml = `<msg><appmsg appid="" sdkver="0"><title>${escapeXML(text)}</title><des></des><action>view</action><type>57</type><refermsg><type>${type}</type><svrid>${message.id}</svrid><fromusr>${escapeXML(from)}</fromusr><chatusr>${escapeXML(context)}</chatusr><displayname>${escapeXML(displayName)}</displayname><content>${escapeXML(String(content))}</content><createtime>${Math.floor(message.timestamp)}</createtime></refermsg><appattach /></appmsg><fromusername>${escapeXML(message.account_id)}</fromusername><scene>0</scene><appinfo><version>1</version><appname></appname></appinfo><commenturl></commenturl></msg>`;
  if (Buffer.byteLength(xml) > 262144)
    throw new APIError("invalid_params", "Quoted message is too large");
  return xml;
}
