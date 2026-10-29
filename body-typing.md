## What
Ephemeral "typing" signal on the conversation stream, for ios #62 ("Typing..." under the chat name).

## Wire format (services/chat/openapi.yaml, tag Stream)
- Client → server (on `GET /v1/conversations/{id}/stream`): `{"type":"typing"}`, sent while the user types (about every 3 s).
- Server → other members' streams: `{"type":"typing","accountId":"…","deviceId":1}`.
- Not echoed to any device of the sender's account; never stored or queued; no push.
- At most 1 relayed per device per 3 s (extra frames are dropped silently).
- Receivers show it for ~5 s since the last signal and hide it when a message from that account arrives.

## Tests
Worker tests first (failing commit, then the fix): relayed to the others, not echoed, not stored (`pendingCount` 0), rate limited, other device of the same account gets nothing.

## Privacy
Typing is metadata: README note for the DPIA/privacy notice (memory only, never stored/logged).

## Local CI
`scripts/check.sh`: all green.

Observers: the room doesn't know roles, so the iOS app must not send `typing` in read-only chats (ios #63).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
