# Contract for the new WeChat hook

Implement the interfaces in `pkg/backend`. They contain no Matrix dependencies. No HTTP or WebSocket wire protocol is prescribed: add an adapter for the hook's final API rather than changing the connector.

## Install an adapter

In the executable, replace `connector.New()` with `connector.NewWithBackend("hook", yourFactory)`. Add configuration handling to the adapter as needed and explicitly set `network.backend: hook`. Unknown backends fail configuration validation; changing an existing login's backend requires authenticating again.

`Factory.StartLogin(ctx, accountReference)` starts authentication. Its challenge may contain a QR string, PNG bytes, or instructions to authenticate through an external client. `Authentication.Wait` completes with a session; `Cancel` must be safe to repeat and unblock pending work.

`Factory.Restore(ctx, accountID)` constructs a session without network IO. The hook/adapter persists its own credentials keyed by stable account ID. Network checks belong in `Session.Connect`, called on startup and retries. Never use a visible nickname as an ID.

## Required operations

| Operation | Meaning |
| --- | --- |
| Connect / Close / Logout | Connect, disconnect, and explicitly invalidate credentials |
| Self | Stable account ID and current user profile |
| Capabilities | Outbound kinds, native replies, mentions, and revocation |
| Contacts / User | Contact discovery and profile lookup |
| Chats / Chat / Members | Existing DM/group discovery, metadata, and members |
| Send | Send one logical message and return its stable remote ID |
| Next | Block for the next event after an opaque cursor |
| OpenMedia | Resolve session-scoped references or inline bytes |

Session methods must honor context cancellation. Lookup, media, and send calls may run concurrently with `Next`; only calls to `Next` are serialized. Serialize UI sends within the adapter when there is one active desktop.

Wrap `ErrUnauthorized` for expired credentials, `ErrDisconnected` for transient connection loss, `ErrUnsupported` for absent features, and `ErrUnavailable` when no hook exists.

## Identity, replay, and sending

- IDs are opaque strings. The bridge scopes portals by login and encodes chat/message IDs to prevent collisions.
- Every event must contain account, chat, sender, message/event ID, and a nonempty cursor following it. IDs remain unchanged on replay.
- `Next(ctx, cursor)` returns one event after that cursor. An empty cursor starts the initial stream. Retain enough history for replay after a restart.
- Matrix processing and persistence complete before the bridge saves the cursor. Processing/checkpoint failures retain the old cursor. A later `Next` supplies the committed cursor; no separate acknowledgement is required.
- `SendRequest.TransactionID` is a stable Matrix event ID. Deduplicate retries using this ID plus account/chat and return the same remote message ID.
- Echoed events contain that transaction ID and remote ID. Do not report temporary local IDs as successful remote delivery.
- Send errors may mean uncertain delivery. The connector does not automatically retry sends.

## Messages and embedded content

`Message.Kind` selects text, image, sticker, video, audio, file, location, card, notice, revocation, or chat metadata change. Media messages may contain multiple attachments with filenames, MIME, dimensions, and duration. Use `ReplyTo` for replies. Use `Event.TargetID` for incoming revocations and `Message.TargetID` for outgoing revocations. Mentions contain stable user IDs.

Populate shared links, articles, mini-apps, videos, and contact cards with readable metadata:

```json
{
  "kind": "card",
  "card": {
    "title": "Article title",
    "description": "Readable summary",
    "source": "Publisher",
    "url": "https://example.com/article",
    "thumbnail": {
      "ref": "opaque-hook-media-id",
      "name": "preview.jpg",
      "mime": "image/jpeg",
      "width": 640,
      "height": 360
    }
  }
}
```

Strings are plain text. The bridge escapes them and activates only absolute HTTP(S) links. `Raw` may retain original structured app-message data; it is never rendered as trusted HTML. No URLs are fetched to invent previews: the hook supplies metadata and optional thumbnail bytes. Missing thumbnails preserve the article. Encrypted rooms receive encrypted preview media.

Outbound text retains hyperlink destinations. Matrix link-preview metadata appears in `Message.Card`; native cards are sent only when advertised, otherwise text remains the fallback. Do not advertise absent capabilities or report unsupported operations as successful. Unknown incoming kinds render a notice.

## Fixtures

`fixtures/demo.json` is a complete example. Byte arrays use base64 JSON strings. Fake fixtures assign sequential cursors and support one-shot cursor faults (`disconnect`, `unauthorized`) and a `send` failure. Tests cover cancellation, replay, account isolation, idempotency, rich cards, encrypted thumbnails, limits, and checkpoint ordering.
