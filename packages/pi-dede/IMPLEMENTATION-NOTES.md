# Audit implementation handoff

Static implementation only: no tests, builds, installs, paid calls or benchmarks were run.

## Changed contracts and limitations

- Initial prompt rejection is correlated to `dede-task` and terminal. Process errors are not evidence of descendant exit.
- Disposal has finite waits and always attempts group cleanup. Unconfirmed cleanup quarantines this extension runtime and suppresses reusable handles. POSIX group probes cannot detect descendants that deliberately leave the group; this is not an OS sandbox. Windows currently fails closed because taskkill/leader exit cannot prove descendant cleanup; a Windows Job Object implementation and platform validation remain follow-up work.
- Artifact initialization is shared; cleanup drains accepted writes. Failed initialization remains failed rather than retrying implicitly. Artifact failures preserve the known answer/outcome and give a persistent JSONL retrieval route.
- Claimed capabilities are restored only before launch. After launch, exceptional outcomes consume capabilities and preserve inspectable sessions.
- Cancelled tool calls still throw. Available details and usage are persisted in a `pi-dede-cancelled` custom session entry. Pi's documented API does not add custom-entry usage to ordinary tool/session totals; cancellation accounting there can remain incomplete. Shutdown may make the old session append API unavailable; failures are reported separately.
- Additional CLI arguments are allowlisted: `-e`/`--extension`, `--provider` (must match the resolved model), `--api-key`, `--skill`, `--no-extensions`, `--no-skills`, `--no-context-files`. Equals forms are normalized. Model, thinking, tools and role instructions use typed agent fields; lifecycle/session/transport/bootstrap switches, unknown flags, positional prompts and NUL bytes are rejected. Profile lists still replace shared lists. Arbitrary extension-specific flags require explicit future support.
- Pi is resolved from the installed package's declared CLI bin, a known `pi` standalone launcher, or a trusted absolute `PI_DEDE_EXECUTABLE` override. Arbitrary host argv entrypoints are never relaunched.
- Fork eligibility compares ordered tool schema/metadata and provenance locally; unverified extension/SDK tools cause auto fallback or forced-fork rejection. Child input checks effective model/tool metadata without an LLM handshake. Later system-prompt changes are detected at agent start. Context hooks and provider payload rewrites cannot be fully reproduced or proven through the public API: provider-prefix equivalence remains best-effort, never guaranteed. Cache reads are observations only.
- Model omission in auto/fork retains the master model even on auto fallback. Explicit isolation uses profile then master defaults. Short-task guidance uses illustrative 60-second execution ceilings, not new global defaults.
- First-event timing measures parsed RPC events. Optional details expose setup, queue, execution, disposal, malformed/oversized counts, warning-sent and cleanup confirmation. Execution includes runner setup; queue is separate. A sent warning is not an acknowledgement. Total tool duration includes sibling critical path and orchestration, not subsequent host inference.
- Writer coordination covers this runtime's children only, not the master, external editors or other Pi processes.

## Deliberately deferred

No verified minimum Pi/Node version or real-Pi supported-version matrix is claimed. Peer/engine ranges remain unchanged pending opt-in deterministic-provider smoke validation. Existing fake-Pi and snapshot tests require review for stricter launcher/fork/CLI contracts. Full injected-clock/filesystem/process race coverage remains follow-up work.

Timeout handle retention remains unchanged (until runtime shutdown); successful handles remain capped at 12 and 30 idle minutes. Automatic routing/escalation, pooling, background workflows, keepalive/cache warming, new end-to-end deadlines and performance/default tuning were not introduced. Direct versus cheap-isolated versus cached-fork evaluations, including correctness, total cost, master inference rounds, repairs, warm/cold latency and parent-next-request usage, remain opt-in future work.
