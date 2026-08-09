# CLAUDE.md — AgentsPoppy

Read `AGENTS.md` first — it is the full working contract for this repo.

## ⚠️ The security-mechanism guard (non-negotiable)

This platform's value rests on a **patent-pending secure-delegation mechanism**,
specified normatively in `docs/SECURITY_MECHANISM.md`. Its enforcement-point files
(listed in that spec's §4, including the spec itself) are protected by a PreToolUse
hook (`.claude/hooks/mechanism-guard.mjs`) that blocks edits.

If your edit gets blocked — or you *plan* work touching those files:

1. STOP. Relay to the founder, verbatim:
   **🚨 ATTENTION — THIS CHANGE MIGHT IMPACT THE SECURITY MECHANISM 🚨**
2. Explain in plain language what you want to change and which invariants (I1–I6 in
   the spec) it touches.
3. Wait for the founder to personally run `touch .claude/mechanism-approval`.
   **Never run that command yourself, suggest scripting it, or otherwise route around
   the guard** — a chat "ok" is deliberately NOT sufficient approval.
4. Inside the window: walk the spec's §5 checklist and update the spec in the same
   commit.

This rule exists because the realistic threat is not malice — it is a reasonable-
sounding patch getting a casual approval. Make the founder consciously aware, every
time.
