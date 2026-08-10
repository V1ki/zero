# Runtime recovery

ZeRo OS separates recovery into process, channel, and session layers. A failure in one
Feishu connection or one conversation does not immediately restart the whole server.

## Process ownership and restart

- The CLI server holds `.zero/server.lock` for its lifetime. A second server exits before it
  opens the databases or writes the shared heartbeat.
- Every server boot writes a unique `bootId` and increasing heartbeat `sequence`.
- Heartbeat files are replaced atomically.
- The supervisor verifies the exact PID and `bootId` it spawned and fails immediately if that
  child exits. It no longer accepts a ready heartbeat from an older process.
- Readiness verification is progress-aware: while the child's heartbeat keeps advancing
  (`sequence`/`stage`), the 120-second window keeps extending, up to a 5-minute hard cap. A slow
  boot under load is no longer killed mid-startup; a stalled boot still fails after one full
  window without progress.
- The repair fuse counts only consecutive failed repair attempts. A successful repair resets the
  streak, so isolated failures spread over a long supervisor lifetime cannot permanently disable
  self-healing. Restarting the supervisor process also resets the in-memory counter.
- Crash recovery uses the existing web bundle. The explicit `bun zero restart` command remains
  responsible for rebuilding the UI before handoff.
- If a stale heartbeat still belongs to a live PID, the supervisor sends SIGTERM and allows
  45 seconds for graceful shutdown before escalating to SIGKILL.

## Channel recovery

Configured non-web channels are monitored inside the server process:

1. A disconnected channel gets a native reconnect grace period. For Feishu this lets the Lark
   SDK reconnect first.
2. After the grace period, ZeRo recovers only that logical channel.
3. Feishu recovery rebuilds its Client, EventDispatcher, and WebSocket while preserving inbound
   message deduplication state.
4. Failed attempts use capped exponential backoff. Only one non-timed-out recovery occupies the
   global slot. A timed-out operation remains single-flight for its own channel but does not
   block recovery of every other bot.
5. Shutdown stops the recovery controller before closing channels.

Default timings:

| Setting | Default |
| --- | ---: |
| Channel health check | 15 seconds |
| Disconnect grace | 3 minutes |
| Initial retry backoff | 30 seconds |
| Maximum retry backoff | 10 minutes |
| Recovery timeout observation | 30 seconds |

The heartbeat `channels` entries include the recovery state, attempt count, disconnect time,
next retry time, last recovery time, and last recovery error.

Feishu connection logs include the logical channel name, for example
`[FeishuSDK:nanoclaw]`, so separate bot connections can be diagnosed independently.

## Stalled session recovery

An active turn records its start time and last meaningful progress. Assistant deltas, model
messages, and tool results refresh progress; a newly queued user message does not.

When a new inbound message finds the current session idle for 30 minutes:

- the old session is quarantined without force-releasing its mutex, and is asked to stop before
  any newly returned tool call executes;
- the channel binding atomically switches to a fresh session;
- the old turn loses delivery permission, so a late result cannot reply as the current session;
- the new inbound message continues in the fresh session;
- memory evaluation is not scheduled against the stuck old turn.

If the quarantined session already has queued messages, ZeRo tells the user how many were left
behind. They are not replayed automatically because a partially completed turn may already have
performed external side effects.

Feishu streaming card updates and terminal cleanup are also bounded. A hung update cannot block
`complete`, `abort`, `dismiss`, or server shutdown indefinitely.

## Configuration

All fields are optional:

```yaml
recovery:
  channel_check_interval_ms: 15000
  channel_disconnect_grace_ms: 180000
  channel_base_backoff_ms: 30000
  channel_max_backoff_ms: 600000
  channel_recovery_timeout_ms: 30000
  session_stall_timeout_ms: 1800000
```

The current health signal is strongest for Feishu and DingTalk. Telegram and Weixin SDKs expose
less precise half-open/auth state, so their application-level recovery still depends on what
their `isConnected()` implementation can detect.
