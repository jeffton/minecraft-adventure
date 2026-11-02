# Player capacity and isolation

The canonical local model catalog supplies Sol/Terra capacity: 500,000 context tokens and 128,000 output tokens at the 2026-11-02 audit. The player preserves that metadata. Automatic Pi Durable compaction starts at `contextWindow − maxTokens` (372,000 for this catalog), reserves the supported answer budget and uses Pi's default recent-history retention. There is no separate tactical context ceiling or engineering round/tool-count budget. One writer submits version-aware controller candidates; accepted admission ends its turn.

Tool results retain complete structured JSON and source. The model's context admission owns capacity; individual results are not cut into JSON prefixes. Controller source, state, observations and action results share a 1 MiB serialized IPC-frame allocation bound. Full frames, including escaping and framing overhead, are checked at admission and decoding. Returned state must fit a complete decision request before persistence. Feedback that cannot fit is an explicit transport failure, with its complete original retained once per action/content identity and retrievable through `controller_inspect({feedbackId})`. Controller validation uses the same OS sandbox as gameplay. World knowledge persists all observed cells; queries expose `truncated` when their requested result window is smaller than the matching set.

## Remaining boundaries

| Boundary | Scope and reason |
| --- | --- |
| Sol medium reasoning | Explicit model reasoning effort; not a context limit. Terra diary uses low. |
| 120 s model stream timeout; no automatic provider retries | Request lifecycle/error handling. Actual failures are surfaced. |
| 120 s action deadline; 1,024 RPC calls/action | Bounds untrusted execution and permits interruption/hot swaps. The next local decision continues play. |
| 192 MiB sandbox RAM, 64 MiB JS heap, 50% CPU, 24 tasks | OS isolation/resource protection. Decisions additionally have short VM/worker deadlines. |
| One physical action/host RPC at a time | Prevents conflicting controls. AI engineering/perception run alongside local play. |
| 2–6 submitted fixtures plus 2 host fixtures | Bounded admission work at a drained action boundary; fixtures test contracts/decisions, not game competence. |
| Local block window: 5×5×4 | Immediate perception, not world memory. Controllers can query loaded blocks and recorded sites. All received non-air blocks/entities reach local decisions. |
| `findBlocks`: radius/count ≤64; names ≤32 | Synchronous loaded-world search workload. Not the exploration boundary: navigation and historical sites extend beyond it. |
| Registry/site query: default 16, maximum 64; names ≤32 | Explicit result window with `truncated`; site memory itself is retained. |
| Vision: one capture in flight; 50 s refresh, 90 s ordinary validity | Browser resource boundary. Reactive engineering requests fresher evidence. Session/life/dimension guards reject stale frames. |
| Recent model events 12; progress actions 12; action-call feedback 8 | Live summaries; selected historical events remain in the append-only log (message text ≤2,000 characters). Controller version history and source remain persisted. |
| Skill verification history 32 | Evidence summary per skill; source and world-specific verification identities remain separate. |
| Diary HTTP input 128 KiB | Separate narration endpoint, not player/controller context. |

Pi Durable 1.4.0 compaction serializes at most 2,000 characters per historical tool result into its summary request. Original entries remain in SQLite; the current controller/state are supplied independently. Compaction is lossy summarization, not an OptChat-style historical retrieval interface.

## Audit evidence

Read-only SQLite sampling after entry 2500 found eight truncated tool results (up to 6,283 dropped bytes) and seven controller candidates rejected by the 20 KiB source policy. Seven accepted controller versions measured 18.7–20.3 KiB; the active version measured 20,040 bytes. This was a demonstrated source/inspection bottleneck.

The Codex adapter in pinned `@earendil-works/pi-ai` 1.4.0 does **not** put `maxTokens` into its request body. The previous 8192 override was metadata, not an enforced wire output cap: real accepted outputs already measured 8,089–9,442 tokens. There is no evidence that a shorter context causes lower latency; this policy makes no such assumption.

Sources: the canonical credential broker's `/models` endpoint (metadata only); installed Pi Durable `dist/harness/types.d.ts`, `compaction.js`, `tool.js`; installed Pi AI `dist/api/openai-codex-responses.js` request builder. Public reference: https://pi.dev/docs/latest/compaction.
