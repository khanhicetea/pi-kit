export const GUIDANCE_MARKER = "## Wise batching: minimize inference barriers";

export const WISE_BATCHING_GUIDANCE = `${GUIDANCE_MARKER}

Model requests become more expensive as session context grows. Optimize for the
smallest sufficient number of inference barriers, not for the largest possible
tool batch.

Before emitting tools, identify every useful call whose complete arguments are
already known. Emit independent calls together in the same assistant response.
A successful tool result is only an acknowledgement, not an information
dependency: do not wait for it before issuing another already-planned call.

Use information-dependency waves:
- Discovery: batch targeted searches and reads when their paths and arguments
  are already known. Keep search then read sequential when search determines
  what to read.
- Mutation: after investigation, form the complete patch wave. Emit one edit
  call per independent file as sibling calls. For one file, put all known
  non-overlapping replacements into one edit call. Never issue sibling writes
  that conflict through the same file or shared mutable state.
- Verification: after required mutations finish, batch independent tests,
  typechecking, linting, and repository checks.
- Repair: spend another model request only when a result changes the next
  action, such as a failed edit, test failure, or newly discovered information.

Pseudo-examples:
- Known independent reads: emit [read(A), read(B)] together, not read(A), wait,
  then read(B).
- Search determines a path: emit search(symbol), inspect its result, then
  read(the discovered path); do not guess and pre-read unrelated files.
- Known independent edits and checks: emit [edit(A), edit(B)] together, then
  after both succeed emit [test, typecheck, lint] together.
- A failed check: inspect its output and issue only the repair it justifies; do
  not rerun every discovery step.

For the bash tool, prefer one well-structured script over a sequence of bash
calls when the commands are one predictable workflow. Write the happy path in
execution order, fail early, and make common failures explain what failed,
where, and why. Use strict shell settings where appropriate, validate expected
inputs and directories, label major stages, and attach focused diagnostics to
likely failure points. Do not hide useful output or collapse unrelated work
into one opaque command.

Pseudo-example:
  bash("""
    set -euo pipefail
    log() { printf '[verify] %s\\n' "$*"; }
    fail() { printf '[verify] ERROR: %s\\n' "$*" >&2; exit 1; }

    [ -f package.json ] || fail 'package.json not found; run from repo root'
    log 'installing dependencies'
    install_command || fail 'dependency install failed; inspect output above'
    log 'running focused tests'
    test_command || fail 'focused tests failed; inspect the named test above'
    log 'verification complete'
  """)

Do not add speculative calls merely to increase parallelism. Bound combined
result volume, avoid overlapping searches and repeated reads, and prefer a call
avoided over a call parallelized.`;
