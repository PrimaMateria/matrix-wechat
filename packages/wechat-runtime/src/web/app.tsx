import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Contact, Conversation, Event, Group, Message, Status } from "../types";
import "./app.css";
import { Avatar } from "./avatar";

const mediaURL = (message: Message) =>
  "/api/media?" + new URLSearchParams({ chat_id: message.chat_id, message_id: message.id });
const thumbnailURL = (message: Message) =>
  mediaURL(message).replace("/api/media?", "/api/thumbnail?");

function SharedCard({ message }: { message: Message }) {
  const [preview, setPreview] = useState(
    message.kind === "channels" ? "video" : message.link?.thumbnail ? "image" : "none",
  );
  const link = message.link!;
  return (
    <div className="linkCard">
      {preview === "video" ? (
        <video
          className="attachmentVideo"
          controls
          preload="metadata"
          src={mediaURL(message)}
          poster={link.thumbnail ? thumbnailURL(message) : undefined}
          onError={() => setPreview(link.thumbnail ? "image" : "none")}
        />
      ) : (
        preview === "image" && (
          <img
            className="attachmentImage"
            src={thumbnailURL(message)}
            alt="Shared card preview"
            onError={() => setPreview("none")}
          />
        )
      )}
      {link.url ? (
        <a href={link.url} target="_blank" rel="noreferrer">
          <strong>{link.title}</strong>
        </a>
      ) : (
        <strong>{link.title}</strong>
      )}
      {link.description && <span>{link.description}</span>}
      <small>{link.source || (link.url ? new URL(link.url).hostname : "WeChat Channels")}</small>
      {message.kind === "channels" && preview !== "video" && (
        <small>Video playback is unavailable in the current WeChat package.</small>
      )}
    </div>
  );
}

function PaymentCard({ message }: { message: Message }) {
  const payment = message.payment!;
  return (
    <div className={`paymentCard ${message.kind}`}>
      <div className="paymentDetails">
        <svg
          className="paymentIcon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {message.kind === "transfer" ? (
            <path d="M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4" />
          ) : (
            <>
              <rect x="5" y="3" width="14" height="18" rx="2" />
              <path d="m5 8 7 5 7-5M10 16h4" />
            </>
          )}
        </svg>
        <div>
          <span className="paymentTitle">{payment.title}</span>
          {payment.amount && <strong className="paymentAmount">{payment.amount}</strong>}
          {payment.description && <p>{payment.description}</p>}
        </div>
      </div>
      <div className="paymentFooter">
        <span>WeChat {payment.title.toLowerCase()}</span>
        <span>Read only</span>
      </div>
    </div>
  );
}

const statusLabel: Record<Status["state"], string> = {
  starting: "Connecting…",
  signing_in: "Signing in…",
  logging_out: "Logging out…",
  awaiting_scan: "Sign in",
  awaiting_confirmation: "Confirm on your phone",
  logged_in: "Connected",
  disconnected: "Disconnected",
};

async function api<T>(
  method: string,
  params: Record<string, unknown> = {},
  post = false,
): Promise<T> {
  const response = await fetch(
    "/api/" +
      method +
      (post
        ? ""
        : "?" +
          new URLSearchParams(
            Object.entries(params)
              .filter(([, v]) => v !== undefined)
              .map(([k, v]) => [k, String(v)]),
          )),
    post
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        }
      : { cache: "no-store" },
  );
  const result = await response.json();
  if (!response.ok) throw Error(result.error?.message || "Request failed");
  return result;
}
function App() {
  const [status, setStatus] = useState<Status>({ state: "starting" }),
    [chats, setChats] = useState<Conversation[]>([]),
    [contacts, setContacts] = useState<Map<string, Contact>>(new Map()),
    [groups, setGroups] = useState<Map<string, Group>>(new Map()),
    [selected, setSelected] = useState(""),
    [messages, setMessages] = useState<Message[]>([]),
    [cursor, setCursor] = useState<string>(),
    [draft, setDraft] = useState(""),
    [reply, setReply] = useState<Message>(),
    [error, setError] = useState(""),
    [filter, setFilter] = useState(""),
    [sending, setSending] = useState(false),
    [loading, setLoading] = useState(false),
    [showMembers, setShowMembers] = useState(false),
    [qr, setQR] = useState(""),
    [loginBusy, setLoginBusy] = useState(false);
  const sendLock = useRef(false),
    reloadPending = useRef(false);
  const account = useRef(""),
    chat = useRef(""),
    generation = useRef(0),
    qrRef = useRef(""),
    mounted = useRef(true),
    messageBox = useRef<HTMLDivElement>(null),
    historyBusy = useRef(false);
  const draftInput = useRef<HTMLTextAreaElement>(null);
  chat.current = selected;
  const name = (id: string) =>
    contacts.get(id)?.name ||
    chats.find((chat) => chat.id === id)?.name ||
    groups.get(id)?.name ||
    (id === "filehelper" ? "File Transfer" : id || "Unknown sender");
  function report(e: unknown) {
    if (mounted.current) setError(e instanceof Error ? e.message : "Request failed");
  }
  function updateQR(next = "") {
    if (qrRef.current) URL.revokeObjectURL(qrRef.current);
    qrRef.current = next;
    if (mounted.current) setQR(next);
  }
  async function conversations() {
    const before = account.current;
    const results = await Promise.allSettled([
      api<{ conversations: Conversation[] }>("conversations"),
      api<{ contacts: Contact[] }>("contacts"),
      api<{ groups: Group[] }>("groups"),
    ]);
    if (before !== account.current || !mounted.current) return;
    const c = results[0],
      u = results[1],
      g = results[2];
    if (c.status === "fulfilled")
      setChats(c.value.conversations.sort((a, b) => b.last_timestamp - a.last_timestamp));
    else throw c.reason;
    if (u.status === "fulfilled") setContacts(new Map(u.value.contacts.map((c) => [c.id, c])));
    if (g.status === "fulfilled") setGroups(new Map(g.value.groups.map((g) => [g.id, g])));
  }
  async function history(older = false) {
    const id = chat.current,
      version = generation.current;
    if (!id) return;
    if (historyBusy.current) {
      reloadPending.current = true;
      return;
    }
    historyBusy.current = true;
    setLoading(true);
    try {
      const page = await api<{ messages: Message[]; next_cursor?: string }>("history", {
        chat_id: id,
        limit: 50,
        cursor: older ? cursor : undefined,
      });
      if (version !== generation.current || id !== chat.current || !mounted.current) return;
      setMessages((previous) =>
        older
          ? [...new Map([...previous, ...page.messages].map((m) => [m.id, m])).values()]
          : page.messages,
      );
      setCursor(page.next_cursor);
      setError("");
      if (!older)
        requestAnimationFrame(() =>
          messageBox.current?.scrollTo(0, messageBox.current.scrollHeight),
        );
    } catch (e) {
      report(e);
    } finally {
      historyBusy.current = false;
      if (mounted.current) {
        setLoading(false);
        if (reloadPending.current) {
          reloadPending.current = false;
          void history();
        }
      }
    }
  }
  async function refresh() {
    try {
      await conversations();
      await history();
      setError("");
    } catch (e) {
      report(e);
    }
  }
  useEffect(() => {
    mounted.current = true;
    let polling = false;
    async function poll() {
      if (polling) return;
      polling = true;
      try {
        const s = await api<Status>("status");
        if (!mounted.current) return;
        const id = s.account?.id || "";
        if (id !== account.current) {
          account.current = id;
          generation.current++;
          setSelected("");
          chat.current = "";
          setChats([]);
          setContacts(new Map());
          setGroups(new Map());
          setMessages([]);
          setCursor(undefined);
          setDraft("");
          setError("");
          if (s.state === "logged_in") await conversations();
        }
        setStatus(s);
        let nextQR = "";
        if (s.state === "awaiting_scan") {
          const r = await fetch("/qr.png", { cache: "no-store" });
          if (r.ok) {
            const blob = await r.blob();
            if (!mounted.current) return;
            nextQR = URL.createObjectURL(blob);
          }
        }
        if (mounted.current) updateQR(nextQR);
      } catch (e) {
        report(e);
      } finally {
        polling = false;
      }
    }
    void poll();
    const timer = setInterval(poll, 3000),
      stream = new EventSource("/api/events");
    stream.addEventListener("ready", () => {
      if (account.current) {
        void conversations().catch(report);
        void history();
      }
    });
    stream.onmessage = (e) => {
      const event: Event = JSON.parse(e.data);
      if (event.account_id && event.account_id !== account.current) return;
      if (event.type === "login.state") {
        setError("");
        if (event.data?.status) setStatus(event.data.status as Status);
        void poll();
        return;
      }
      if (event.type === "connection.closed") {
        setStatus({ state: "disconnected" });
        return;
      }
      if (event.chat_id === chat.current) void history();
      void conversations().catch(report);
    };
    return () => {
      mounted.current = false;
      clearInterval(timer);
      stream.close();
      updateQR();
    };
  }, []);
  useEffect(() => {
    generation.current++;
    setMessages([]);
    setCursor(undefined);
    setShowMembers(false);
    setReply(undefined);
    void history();
  }, [selected]);
  async function sessionAction(action: "login" | "logout", mode?: "prompt" | "qr") {
    if (loginBusy) return;
    setLoginBusy(true);
    setError("");
    try {
      await api(action, mode ? { mode } : {}, true);
      setStatus(await api<Status>("status"));
    } catch (e) {
      report(e);
    } finally {
      setLoginBusy(false);
    }
  }
  async function submitMessage(action: () => Promise<void>) {
    if (sendLock.current || !selected) return;
    sendLock.current = true;
    setSending(true);
    setError("");
    try {
      await action();
      await history();
      await conversations();
    } catch (e) {
      report(e);
    } finally {
      sendLock.current = false;
      setSending(false);
    }
  }
  async function send() {
    if (!draft.trim()) return;
    const text = draft,
      id = selected;
    await submitMessage(async () => {
      await api("send", { chat_id: id, kind: "text", text, reply_to: reply?.id }, true);
      if (chat.current === id) {
        setDraft("");
        setReply(undefined);
      }
    });
  }
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  async function sendAttachment(file: File, kind: "image" | "file") {
    await submitMessage(async () => {
      const form = new FormData();
      form.set("chat_id", selected);
      form.set(kind, file);
      const response = await fetch(`/api/send-${kind}`, { method: "POST", body: form });
      const result = await response.json();
      if (!response.ok) throw Error(result.error?.message || "Attachment could not be sent");
    });
  }
  const group = groups.get(selected),
    ordered = [...messages].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id)),
    byID = new Map(messages.map((message) => [message.id, message]));
  return (
    <>
      <header>
        <h1>WeChat</h1>
        <span className="status">{statusLabel[status.state]}</span>
        {status.state === "logged_in" && (
          <>
            <button onClick={() => void refresh()}>Refresh</button>
            <button disabled={loginBusy || sending} onClick={() => void sessionAction("logout")}>
              Log out
            </button>
          </>
        )}
      </header>
      {error && (
        <div className="error" role="alert">
          {error}
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            ×
          </button>
        </div>
      )}
      {status.state !== "logged_in" ? (
        <section className="login">
          <h2>{statusLabel[status.state]}</h2>
          {status.state === "awaiting_confirmation" ? (
            <>
              <p>Open WeChat on your phone to approve this login.</p>
            </>
          ) : qr ? (
            <>
              <img src={qr} alt="WeChat login QR code" />
              <p>Scan with WeChat to sign in.</p>
            </>
          ) : (
            <p>
              {status.state === "logging_out"
                ? "Waiting for WeChat to end the session…"
                : statusLabel[status.state]}
            </p>
          )}
          <div>
            <button
              disabled={loginBusy || status.state === "logging_out"}
              onClick={() => void sessionAction("login", "prompt")}
            >
              Request phone confirmation
            </button>{" "}
            <button
              disabled={loginBusy || status.state === "logging_out"}
              onClick={() => void sessionAction("login", "qr")}
            >
              Use QR code
            </button>
          </div>
        </section>
      ) : (
        <main>
          <aside>
            <input
              placeholder="Search"
              aria-label="Search conversations"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <nav>
              {chats
                .filter((c) =>
                  (name(c.id) + " " + c.id).toLowerCase().includes(filter.toLowerCase()),
                )
                .map((c) => (
                  <button
                    className={"chat " + (selected === c.id ? "selected" : "")}
                    key={c.id}
                    onClick={() => setSelected(c.id)}
                  >
                    <Avatar id={c.id} label={name(c.id)} />
                    <span>{name(c.id)}</span>
                    {c.unread_count > 0 && <small>{c.unread_count}</small>}
                  </button>
                ))}
              {!chats.length && <p className="empty">No conversations yet.</p>}
            </nav>
          </aside>
          <section className="conversation">
            <div className="chatHeader">
              {selected && <Avatar key={selected} id={selected} label={name(selected)} />}
              <strong>{selected ? name(selected) : "Select a conversation"}</strong>
              {selected.endsWith("@chatroom") && (
                <button onClick={() => setShowMembers((v) => !v)}>Members</button>
              )}
            </div>
            {showMembers && (
              <div className="members">
                {group?.topic && <p>{group.topic}</p>}
                {group?.members?.map((m) => (
                  <div className="member" key={m.id}>
                    <Avatar id={m.id} label={m.name || m.id} />
                    {m.name || m.id}
                  </div>
                ))}
                {!group?.members?.length && <p>No member details available.</p>}
              </div>
            )}
            <div ref={messageBox} className="messages">
              {cursor && (
                <button className="older" disabled={loading} onClick={() => void history(true)}>
                  Older messages
                </button>
              )}
              {ordered.map((m) => (
                <article
                  className={
                    "message " +
                    (m.kind === "system" ? "system" : m.own ? "own" : "") +
                    (m.payment ? " paymentMessage" : "")
                  }
                  key={m.local_key || m.id}
                >
                  {m.kind !== "system" && (
                    <div className="bubbleAvatar">
                      <Avatar id={m.sender_id} label={name(m.sender_id)} />
                    </div>
                  )}
                  {m.kind !== "system" && (
                    <div className="meta">
                      {m.own ? "You" : name(m.sender_id)} ·{" "}
                      {new Date(
                        m.timestamp < 1e12 ? m.timestamp * 1000 : m.timestamp,
                      ).toLocaleString()}
                    </div>
                  )}
                  {m.reply_to && (
                    <blockquote>
                      <strong>
                        {m.quote?.sender_name ||
                          name(m.quote?.sender_id || byID.get(m.reply_to)?.sender_id || "")}
                      </strong>
                      <div>{m.quote?.text || byID.get(m.reply_to)?.text || "Quoted message"}</div>
                    </blockquote>
                  )}
                  <div>
                    {m.kind === "sticker" || m.kind === "image" ? (
                      <img
                        className={m.kind === "image" ? "attachmentImage" : "sticker"}
                        src={mediaURL(m)}
                        alt={m.kind === "image" ? "Image attachment" : "Sticker"}
                      />
                    ) : m.kind === "audio" ? (
                      <audio controls preload="none" aria-label="Voice message" src={mediaURL(m)} />
                    ) : m.kind === "video" ? (
                      <video
                        className="attachmentVideo"
                        controls
                        preload="metadata"
                        aria-label="Video message"
                        src={mediaURL(m)}
                      />
                    ) : m.kind === "file" ? (
                      <a download href={mediaURL(m)}>
                        {m.media?.name || "Download file"}
                      </a>
                    ) : m.link ? (
                      <SharedCard message={m} />
                    ) : m.payment ? (
                      <PaymentCard message={m} />
                    ) : (
                      (m.text ??
                      (m.kind === "location"
                        ? m.location?.label || "Location"
                        : "[" + m.kind + "]"))
                    )}
                  </div>
                  {m.mentions?.length && <small>{m.mentions.map(name).join(", ")}</small>}
                  {m.kind !== "system" && /^[1-9]\d*$/.test(m.id) && (
                    <button
                      className="replyButton"
                      type="button"
                      disabled={sending}
                      onClick={() => {
                        setReply(m);
                        draftInput.current?.focus();
                      }}
                    >
                      Reply
                    </button>
                  )}
                </article>
              ))}
              {!ordered.length && (
                <p className="empty">
                  {loading ? "Loading…" : selected ? "No messages yet." : "Choose a conversation."}
                </p>
              )}
            </div>
            {selected && (
              <>
                {reply && (
                  <div className="replyDraft">
                    <span>
                      Replying to {reply.own ? "You" : name(reply.sender_id)}:{" "}
                      {reply.text || `[${reply.kind}]`}
                    </span>
                    <button
                      type="button"
                      aria-label="Cancel reply"
                      onClick={() => setReply(undefined)}
                    >
                      ×
                    </button>
                  </div>
                )}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send();
                  }}
                >
                  <input
                    className="hidden"
                    ref={imageInput}
                    type="file"
                    accept="image/png,image/jpeg,image/gif"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) void sendAttachment(file, "image");
                    }}
                  />
                  <button
                    type="button"
                    disabled={sending}
                    onClick={() => imageInput.current?.click()}
                  >
                    Image
                  </button>
                  <input
                    className="hidden"
                    ref={fileInput}
                    type="file"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) void sendAttachment(file, "file");
                    }}
                  />
                  <button
                    type="button"
                    disabled={sending}
                    onClick={() => fileInput.current?.click()}
                  >
                    File
                  </button>
                  <textarea
                    ref={draftInput}
                    aria-label="Message"
                    placeholder="Message"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                  />
                  <button className="send" disabled={sending || !draft.trim()}>
                    {sending ? "Sending…" : "Send"}
                  </button>
                </form>
              </>
            )}
          </section>
        </main>
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
