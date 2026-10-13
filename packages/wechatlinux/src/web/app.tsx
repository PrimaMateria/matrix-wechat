import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Contact, Conversation, Event, Group, Message, Status } from "../types";
import "./app.css";
import { Avatar } from "./avatar";

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
  chat.current = selected;
  const name = (id: string) =>
    contacts.get(id)?.name ||
    chats.find((chat) => chat.id === id)?.name ||
    groups.get(id)?.name ||
    (id === "filehelper" ? "File Transfer" : id || "Unknown sender");
  function report(e: unknown) {
    if (mounted.current) setError(e instanceof Error ? e.message : "Request failed");
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
        if (s.state === "awaiting_scan") {
          const r = await fetch("/qr.png", { cache: "no-store" });
          if (r.ok) {
            const next = URL.createObjectURL(await r.blob());
            if (qrRef.current) URL.revokeObjectURL(qrRef.current);
            qrRef.current = next;
            setQR(next);
          }
        } else {
          if (qrRef.current) URL.revokeObjectURL(qrRef.current);
          qrRef.current = "";
          setQR("");
        }
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
        void poll();
        return;
      }
      if (event.type === "login.confirmation_required") {
        setStatus({ state: "awaiting_confirmation" });
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
      if (qrRef.current) URL.revokeObjectURL(qrRef.current);
    };
  }, []);
  useEffect(() => {
    generation.current++;
    setMessages([]);
    setCursor(undefined);
    setShowMembers(false);
    void history();
  }, [selected]);
  async function retryLogin(mode: "saved" | "qr") {
    if (loginBusy) return;
    setLoginBusy(true);
    setError("");
    try {
      await api("login/retry", { mode }, true);
      setStatus(await api<Status>("status"));
    } catch (e) {
      report(e);
    } finally {
      setLoginBusy(false);
    }
  }
  async function send() {
    if (sendLock.current || !draft.trim() || !selected) return;
    sendLock.current = true;
    const text = draft,
      id = selected;
    setSending(true);
    setError("");
    try {
      await api("send", { chat_id: id, kind: "text", text }, true);
      if (chat.current === id) setDraft("");
      await history();
      await conversations();
    } catch (e) {
      report(e);
    } finally {
      sendLock.current = false;
      setSending(false);
    }
  }
  const imageInput = useRef<HTMLInputElement>(null);
  async function sendImage(file: File) {
    if (sendLock.current || !selected) return;
    sendLock.current = true;
    setSending(true);
    setError("");
    try {
      const form = new FormData();
      form.set("chat_id", selected);
      form.set("image", file);
      const response = await fetch("/api/send-image", { method: "POST", body: form });
      const result = await response.json();
      if (!response.ok) throw Error(result.error?.message || "Image could not be sent");
      await history();
      await conversations();
    } catch (error) {
      report(error);
    } finally {
      sendLock.current = false;
      setSending(false);
    }
  }
  const group = groups.get(selected),
    ordered = [...messages].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  return (
    <>
      <header>
        <h1>WeChat</h1>
        <span className="status">
          {status.state === "logged_in"
            ? "Connected"
            : status.state === "awaiting_confirmation"
              ? "Confirm on phone"
              : status.state === "disconnected"
                ? "Disconnected"
                : "Signing in"}
        </span>
        {status.state === "logged_in" && <button onClick={() => void refresh()}>Refresh</button>}
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
          <h2>{status.state === "awaiting_confirmation" ? "Confirm on your phone" : "Sign in"}</h2>
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
            <p>{status.state === "disconnected" ? "WeChat disconnected." : "Connecting…"}</p>
          )}
          <div>
            <button disabled={loginBusy} onClick={() => void retryLogin("saved")}>
              Request again
            </button>{" "}
            <button disabled={loginBusy} onClick={() => void retryLogin("qr")}>
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
                  className={"message " + (m.kind === "system" ? "system" : m.own ? "own" : "")}
                  key={m.local_key || m.id}
                >
                  {m.kind !== "system" && (
                    <div className="meta">
                      <Avatar id={m.sender_id} label={name(m.sender_id)} />
                      {m.own ? "You" : name(m.sender_id)} ·{" "}
                      {new Date(
                        m.timestamp < 1e12 ? m.timestamp * 1000 : m.timestamp,
                      ).toLocaleString()}
                    </div>
                  )}
                  {m.reply_to && <blockquote>Reply to {m.reply_to}</blockquote>}
                  <div>
                    {m.kind === "sticker" || m.kind === "image" ? (
                      <img
                        className={m.kind === "image" ? "attachmentImage" : "sticker"}
                        src={
                          "/api/media?" +
                          new URLSearchParams({
                            chat_id: m.chat_id,
                            message_id: m.id,
                          })
                        }
                        alt={m.kind === "image" ? "Image attachment" : "Sticker"}
                      />
                    ) : m.kind === "audio" ? (
                      <audio
                        controls
                        preload="none"
                        aria-label="Voice message"
                        src={
                          "/api/media?" +
                          new URLSearchParams({
                            chat_id: m.chat_id,
                            message_id: m.id,
                          })
                        }
                      />
                    ) : m.kind === "file" ? (
                      <a
                        download
                        href={
                          "/api/media?" +
                          new URLSearchParams({ chat_id: m.chat_id, message_id: m.id })
                        }
                      >
                        {m.media?.name || "Download file"}
                      </a>
                    ) : (
                      (m.text ??
                      (m.kind === "location"
                        ? m.location?.label || "Location"
                        : "[" + m.kind + "]"))
                    )}
                  </div>
                  {m.mentions?.length && <small>{m.mentions.map(name).join(", ")}</small>}
                </article>
              ))}
              {!ordered.length && (
                <p className="empty">
                  {loading ? "Loading…" : selected ? "No messages yet." : "Choose a conversation."}
                </p>
              )}
            </div>
            {selected && (
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
                  accept="image/png,image/jpeg"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void sendImage(file);
                  }}
                />
                <button
                  type="button"
                  disabled={sending}
                  onClick={() => imageInput.current?.click()}
                >
                  Image
                </button>
                <textarea
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
            )}
          </section>
        </main>
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
