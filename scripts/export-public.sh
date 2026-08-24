#!/bin/bash
# Export the PUBLIC mirror of the AgentsPoppy repo.
#
# THIS repo is PRIVATE and canonical, forever. Its visibility must NEVER be
# changed — its history contains identifiers and working state that were never
# meant to be published. The public repo is produced ONLY by this script: a
# WHITELIST of paths, exported from committed HEAD (never the working tree,
# never gitignored files), into a staging repo whose history is just the sync
# commits. Nothing private can leak by default — a new top-level file stays
# private unless someone adds it to PUBLIC_PATHS on purpose.
#
#   scripts/export-public.sh <staging-dir>            # export + verify only
#   scripts/export-public.sh <staging-dir> <remote>   # …then commit & push
#
# Sibling implementation: mailpoppy/scripts/export-public.sh (same model; that
# one also excludes whole private apps, which AgentsPoppy has none of).
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# ---- The whitelist. Everything else stays private. --------------------------
# AgentsPoppy is meant to be public in full, so this is currently the entire
# tracked tree. It is still an explicit list: anything added later is private
# until someone deliberately publishes it.
PUBLIC_PATHS=(
  LICENSE
  NOTICE
  README.md
  TRADEMARK.md
  MANIFESTO.md
  AGENTS.md
  CLAUDE.md
  .gitignore
  .github
  .claude
  package.json
  package-lock.json
  tsconfig.base.json
  app
  brand
  docs
  examples
  infra
  packages
  scripts
)

# Paths that must NEVER appear, even if a whitelist entry grows to cover them.
FORBIDDEN=(
  node_modules
  .env
  .claude/mechanism-approval
  scripts/export-denylist.txt
)

# Literal strings that must never reach the mirror. They live in a SEPARATE
# file that is deleted from the export before the gates run — holding them in
# this script would publish the very identifiers the gate suppresses, since
# this script is itself exported. (The first sync attempt failed on exactly
# that, which is the gate working.)
DENYLIST_FILE="scripts/export-denylist.txt"
# A missing denylist must ABORT, never quietly export with the scrub gate off.
# It went missing twice on 2026-08-24; an empty FORBIDDEN_STRINGS would have
# printed "gates passed" while scrubbing nothing.
if [ ! -f "$DENYLIST_FILE" ]; then
  echo "FATAL: $DENYLIST_FILE is missing — it holds the identifiers that must never" >&2
  echo "       be published, and its absence silently disables the scrub gate." >&2
  exit 1
fi
FORBIDDEN_STRINGS=()
if [ -f "$DENYLIST_FILE" ]; then
  while IFS= read -r line; do
    [[ -z "$line" || "$line" == \#* || "$line" == path:* ]] && continue
    FORBIDDEN_STRINGS+=("$line")
  done < "$DENYLIST_FILE"
fi

# AWS account ids that are allowed to appear (documentation/reserved values).
# 111122223333 and 123456789012 are AWS's own doc placeholders.
ALLOWED_ACCOUNTS="123456789012|111122223333|000000000000|999999999999|111111111111"

STAGING="${1:?usage: export-public.sh <staging-dir> [push-remote-url]}"
REMOTE="${2:-}"

if ! git diff-index --quiet HEAD --; then
  echo "note: working tree has uncommitted changes — exporting committed HEAD only." >&2
fi
SRC_SHA=$(git rev-parse --short HEAD)

mkdir -p "$STAGING"
if [ ! -d "$STAGING/.git" ]; then
  git -C "$STAGING" init -q -b main
fi

# Replace the staging contents with the export (keep .git so syncs accumulate as
# commits). git archive exports committed blobs only — never the working tree.
find "$STAGING" -mindepth 1 -maxdepth 1 -not -name .git -exec rm -rf {} +
git archive HEAD -- "${PUBLIC_PATHS[@]}" | tar -x -C "$STAGING"

# The denylist is whitelisted-in by `scripts/`, so drop it before the gates run.
# It must never be published: it IS the list of things we're hiding.
rm -f "$STAGING/$DENYLIST_FILE"

# INTERNAL-ONLY documents. These NEVER go public (founder, 2026-08-24). An audit
# enumerates our own weaknesses, several on the vendor side which is not public
# and so cannot be read alongside them — publishing it hands a reader a map with
# no territory. Removed here rather than added to FORBIDDEN because FORBIDDEN
# aborts the whole export; these should be silently dropped, every time.
#
# The trap this closes: the whitelist gates new TOP-LEVEL paths, but a new file
# inside an already-whitelisted directory (docs/) publishes itself on the next
# sync with no decision from anyone. AUDIT-2026-08-16.md nearly did exactly that.
# Internal-only paths live in the denylist file, which is deleted from the export
# above — naming them here would publish the fact that we withhold an audit, and
# its date, in the very file a reader can see. One path per line, "path:" prefix.
while IFS= read -r line; do
  [[ "$line" == path:* ]] || continue
  rm -f "$STAGING/${line#path:}"
done < <(cat "$DENYLIST_FILE" 2>/dev/null || true)

# Belt and braces: any docs/ file whose name marks it internal is dropped too, so
# the next audit or postmortem cannot leak by being new rather than listed.
find "$STAGING/docs" -maxdepth 1 -type f \( -name 'AUDIT-*' -o -name 'INTERNAL-*' -o -name 'POSTMORTEM-*' \) -delete 2>/dev/null || true

# ---- Safety gates -----------------------------------------------------------
fail() { echo "FATAL: $1 — aborting, nothing pushed." >&2; exit 1; }

for p in "${FORBIDDEN[@]}"; do
  [ -e "$STAGING/$p" ] && fail "forbidden path '$p' appeared in the export"
done

for s in "${FORBIDDEN_STRINGS[@]}"; do
  if grep -rIn --exclude-dir=.git -F "$s" "$STAGING"; then
    fail "scrubbed identifier '$s' is back in the export (shown above)"
  fi
done

# Credential-shaped secrets.
if grep -rInE --exclude-dir=.git \
  "AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|sk_live_[0-9a-zA-Z]{8,}|rk_live_[0-9a-zA-Z]{8,}|whsec_[0-9a-zA-Z]{8,}|ghp_[0-9A-Za-z]{30,}|github_pat_[0-9A-Za-z_]{20,}|xox[baprs]-[0-9A-Za-z-]{10,}|sk-ant-[0-9A-Za-z_-]{20,}|-----BEGIN( RSA| EC| OPENSSH| PGP)? ?PRIVATE KEY" \
  "$STAGING"; then
  fail "potential credential found in the export (shown above)"
fi

# Any AWS account id that is not a documentation placeholder. This is the check
# that would have caught the 2026-08-09 scrub subject, and MailPoppy's earlier
# HomeView.test.tsx leak of live Cognito ids — an account number is not secret,
# but publishing a live one hands an attacker a free target.
# Match 12-OR-MORE digits and keep only the exactly-12 ones, so a longer number
# (an epoch-ms timestamp, say) isn't flagged on its first 12 digits. -I skips
# binaries, whose byte soup matches anything.
STRAY=$(grep -rhoIE --exclude-dir=.git --exclude='*.lock' --exclude='package-lock.json' \
  '[0-9]{12,}' "$STAGING" 2>/dev/null | awk 'length($0) == 12' | sort -u \
  | grep -vE "^($ALLOWED_ACCOUNTS)$" || true)
if [ -n "$STRAY" ]; then
  echo "$STRAY" | sed 's/^/  /' >&2
  fail "12-digit value(s) above are not known documentation account ids — check them"
fi

# ---- Internal-content gate --------------------------------------------------
# A filename sweep is not a guard: docs/CONFINEMENT-MIGRATION.md slipped through
# the name-based one in the very commit that added it, because it was not called
# AUDIT-*. These match on what internal documents CONTAIN, which is far harder to
# get wrong by accident: a path from a developer's own machine, an unpushed
# commit, or a reference to a repo that is not public.
INTERNAL_SIGNALS=$(grep -rInE --exclude-dir=.git --include='*.md' \
  '/Users/[a-z]+/Projects|local, not (pushed|released)|founder says|agentspoppy-web/src|mailpoppy/apps/web' \
  "$STAGING" | grep -v 'internal-content-ok' || true)
if [ -n "$INTERNAL_SIGNALS" ]; then
  echo "$INTERNAL_SIGNALS" | head -20 | sed 's/^/  /' >&2
  fail "the file(s) above read as INTERNAL notes (developer paths / unpushed commits / private repos) — publish a rewritten version or add the path to the denylist"
fi

# ---- Claim gate: the mirror must not contradict what shipped ----------------
# People read this repo to check whether our claims are true. A doc left in the
# pre-flip tense is not a cosmetic problem — on 2026-08-24 an external auditor
# read exactly such a line and concluded, correctly from what was in front of
# them, that backend confinement was still opt-in. Whenever a security default
# changes, the words have to move with the code or this gate fails the export.
CLAIM_HITS=$(grep -rInE --exclude-dir=.git --include='*.md' --include='*.ts' \
  'default is (still )?.?"?none|defaults? to .?"?none|[Tt]oday the default is unconfined|isolation is opt-in|confinement is opt-in' \
  "$STAGING" | grep -v 'claim-gate-ok' || true)
if [ -n "$CLAIM_HITS" ]; then
  echo "$CLAIM_HITS" | sed 's/^/  /' >&2
  fail "the line(s) above say confinement is not the default — it is, since 0.3.5. Fix the words or this repo disproves our own claim"
fi

COUNT=$(find "$STAGING" -type f -not -path "*/.git/*" | wc -l | tr -d ' ')
echo "✅ export ready: $COUNT files from agentspoppy@$SRC_SHA → $STAGING"
echo "   gates passed: no forbidden paths · no scrubbed identifiers · no credentials · no stray account ids"

# ---- Optional commit + push -------------------------------------------------
if [ -n "$REMOTE" ]; then
  git -C "$STAGING" add -A
  if git -C "$STAGING" diff --cached --quiet; then
    echo "nothing changed since the last sync — not pushing."
  else
    git -C "$STAGING" commit -q -m "sync: agentspoppy@$SRC_SHA"
    git -C "$STAGING" remote remove origin 2>/dev/null || true
    git -C "$STAGING" remote add origin "$REMOTE"
    git -C "$STAGING" push -u origin main
    echo "✅ pushed sync of $SRC_SHA to $REMOTE"
  fi
fi
