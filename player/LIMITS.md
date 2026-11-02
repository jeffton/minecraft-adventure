# Player capacity and isolation

The canonical model catalog supplies capacity: Sol/Terra currently advertise 500,000 context tokens and 128,000 output tokens. Pi Durable compacts at `contextWindow − maxTokens` (372,000 for this catalog), reserving the supported answer budget. Engineering has no independent context ceiling, output override, model-round quota or tool-call quota. Complete structured tool results reach the model.

`controller_edit` applies exact unique, nonoverlapping replacements against an inspected `baseVersion`. It shares full-source syntax/import/async-entrypoint admission and provenance; a small repair does not reproduce unchanged code. Accepted edits cancel generated work safely, drain host RPC and activate immediately. No offline gameplay fixtures, performance approval or automatic rollback gate generated code. Runtime errors return to the AI for the next edit.

Controller source, state, inputs/results and diagnostics share a 1 MiB serialized IPC-frame boundary. Complete encoded frames, including escaping and framing overhead, are checked at admission and decoding. State must fit a complete decision request before persistence. Feedback that cannot fit becomes an explicit transport failure; its complete original is retained and retrievable through `controller_inspect({feedbackId})`. Repeated identical feedback reuses that reference across restart.

Action records, RPC call history, skill verification and world knowledge have no retention-count quota. Raw action/RPC originals persist on disk; completed records and accumulated call payloads do not remain in the player's resident action map. `action_inspect` exposes complete retained action records. `read_events` streams complete persisted event records selected by session, sequence and event type, without line/byte clipping. Routine model observations deliver new semantic events rather than repeating the entire log. All event types and full error messages remain in the append-only log.

Registry/site queries return all matches unless the caller explicitly requests a result window. Block searches iterate only actually loaded columns, yielding between sections and respecting unload/cancellation. Optional radius/count are caller-selected filters, not host ceilings. Nearest-count queries retain only their requested candidates; results that cannot fit the actual serialized RPC frame fail explicitly while collecting. This avoids Mineflayer's unbounded octahedron traversal through unloaded space. Unknown world coordinates are never invented.

## Retained boundaries

| Boundary | Reason |
| --- | --- |
| Model window; Pi compaction | The provider's actual finite request capacity. Pi keeps its default recent-history retention. |
| 1 MiB complete IPC frames | Bounds individual untrusted allocations across the root broker/isolated worker boundary relative to 192 MiB worker RAM. Oversize messages fail explicitly. |
| 192 MiB worker RAM, 64 MiB JS heap, 50% CPU, 24 tasks; 120 s action deadline | OS protections terminate runaway execution. Local decision VMs also retain short execution watchdogs. |
| One physical action/host RPC at a time | Prevents conflicting controls. Hot reload uses safe cancellation/drain, not an action-completion approval gate. Model engineering/perception remain independent. |
| Model request timeout; visible error backoff | Connection/process liveness, not a successful-job cooldown or token quota. |
| Safe identifiers, filesystem filename length, valid protocol values | Prevents path traversal and invalid Minecraft packets. Health, click modes and world coordinates retain game/protocol validation. |
| Browser memory cap, one capture in flight | Real GPU/browser resource isolation. Missing images are explicit and do not block text-state analysis. Session/life/dimension guards reject stale evidence. |
| Immediate `observe()` block sampling | A 5×5×4 local snapshot, not the accessible-world boundary. Uncapped loaded-world searches, entity observations and persistent sites are available through RPC. |
| Paper view/simulation distance; renderer distance | Server/client loaded-world and browser workloads, not AI context quotas. The player uses Mineflayer's default requested view distance; Paper grants the actual loaded domain. |
| Diary title/format rules and narration endpoint | Separate presentation requirements, not player planning capacity. |

Pi Durable 1.4.0 serializes at most 2,000 characters per historical tool result into compaction summary requests. Original entries remain in SQLite; current controller/state and the event log remain independently accessible. This is upstream lossy summarization, not an OptChat-style historical retrieval interface.

## Audit evidence

Read-only sampling after SQLite entry 2500 found eight truncated tool results (up to 6,283 dropped bytes) and seven candidates rejected by the 20 KiB source policy. Accepted controller versions crowded that ceiling; the sampled active source measured 20,040 bytes.

Pinned Pi AI 1.4.0's Codex request builder does not put `maxTokens` on the wire. The former 8192 override was metadata, not an enforced output cap: accepted outputs already measured 8,089–9,442 tokens. No latency claim is inferred from context length.

Sources: credential broker `/models` metadata; installed Pi Durable `dist/harness/types.d.ts`, `compaction.js`, `tool.js`; installed Pi AI `dist/api/openai-codex-responses.js`; installed Mineflayer `lib/plugins/blocks.js` and Prismarine World's `getColumns()`. Public reference: https://pi.dev/docs/latest/compaction.
