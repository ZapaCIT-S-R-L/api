## What
Per-account events WebSocket so phones learn about new conversations while the app is open (ios #65, option 1). Fixes group calls not ringing (the ring is a `.call` chat message on the conversation stream, which the phone never opened) and new chats not appearing until restart.

## Wire format (services/chat/openapi.yaml, tag Account events)
- `GET /v1/events` with `Upgrade: websocket` and the chat token (`Authorization: Bearer`). 426 if not a WebSocket, 401 without a token, 429 shares the connect limiter.
- Server → client: `{"type":"conversation_added","conversationId":"c_…"}`. Sent to every member of a new conversation (creator, other members, observing parents), and to a parent who becomes an observer of an existing kid chat later. Not sent when `POST /v1/conversations` returns the existing 1:1 (200).
- Client → server: only `ping` (`pong`). Close code 4401: token expired or revoked, reconnect with a fresh token.
- Ids only, never stored. A phone that was offline lists its conversations at start, so a missed frame costs nothing. App: on frame → `GET /v1/conversations/{id}` → open its stream (`connectAll`); also reconnect/refresh when the app becomes active.

## Implementation
New Durable Object `AccountHub` (binding `ACCOUNTS`, migration `v2`, EU jurisdiction when deployed, same as the conversation objects). `Rooms` gets `conversationAdded` and `revokeAccountSessions` (logout-all closes these sockets too).

## Tests
Worker tests first (failing commit, then the fix): members and observers told, outsiders not, existing 1:1 not repeated, observer added later, 426/401; recordingRooms log assertions updated.

## Notes for Stefan
Deploy adds a Durable Object class (migration v2); no data changes. Privacy: ids to the account's own devices only, README updated.

## Local CI
`scripts/check.sh`: all green.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
