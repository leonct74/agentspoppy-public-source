# Spec — "What's new", and telling people an update exists

**Status:** proposed · 25 August 2026
**Why:** a user has no way to learn what a version shipped, and on Windows no way to learn a
version shipped at all
**Type:** additive. No security surface changes.

---

## What exists today

More than expected, and less.

**The update check works on macOS and Linux.** The app fetches a signed `latest.json`, and shows
*"AgentsPoppy X is available / Update & restart"*. Consent-first, already built.

**The release notes are already downloaded — and thrown away.** The feed carries a `notes` field;
the app reads it into `update.body` and never renders it. A user is asked to accept an update
without being told what is in it.

**Windows is structurally excluded, on purpose.** The Windows key is deliberately omitted from
`latest.json`, and the updater errors when its platform key is missing, so the check returns
nothing and no banner appears. **Do not "fix" this by adding the key.** It was tried in v0.2.6:
a Store-installed copy downloads the unsigned installer over itself. The recorded precondition
for ever adding it is MSIX-context detection, which does not exist.

**The app never shows its own version anywhere**, and there is no Settings or About screen. It
*can* read its version at runtime on all three platforms including MSIX — the API is available
and already permitted.

## The design

Three pieces, of which only the first is truly cross-platform.

### 1. A release-notes feed, served first-party

Notes live in the repo (`src/data/release-notes.json` on the website) and are served as a CORS'd
JSON route, exactly like the catalogue already is. Two reasons over reading GitHub's release
bodies directly: no third-party origin, and no 60-requests-per-hour unauthenticated rate limit.

Each entry: version, date, a one-line summary, and a short list of user-facing changes. Written
for a person deciding whether they care — not a changelog, and never a commit list.

```json
{ "version": "0.3.6", "date": "2026-08-25",
  "summary": "Poppy packages are verified more strictly before they install.",
  "changes": ["A package can no longer say one thing to the reviewer and install another."] }
```

### 2. "What's new" after an update — the part that works everywhere

On launch, compare the running version against the last version the app recorded seeing. If it
changed, show what's new, then record it.

**This is the whole feature on Windows.** The Store updates silently and tells the user nothing,
so this turns a silent swap into something they can read. It is more valuable there than on the
platforms that already have a banner.

It also needs no update mechanism at all — only the version the app is already able to read — so
it works identically on Store installs, NSIS installs, DMGs and AppImages.

A user can reopen it any time from the same place the version is shown.

### 3. "An update is available" — honest per platform

**macOS and Linux:** the existing banner, now rendering the notes it already fetches. One
sentence of what changed, next to the button that installs it.

**Windows:** a passive line from the same feed — *"0.3.6 is out. The Microsoft Store installs it
automatically."* No button.

That wording is a deliberate limit, not laziness. The Store does not let an app install its own
update, and the app **cannot currently tell a Store install from an NSIS one**, so it cannot know
whether to say "the Store will handle it" or "you must download it yourself". Offering to update
would be a promise the channel cannot keep. If MSIX detection is ever built, this line can become
two accurate ones.

## Where it lives in the app

There is no Settings or About screen to put this in, so one small surface is added: the version,
and a link to what's new. That is also the first place the app has ever shown a user which
version they are running — worth having on its own, and necessary for any support conversation.

## Release discipline

The feed is only as good as the habit. Adding the version's entry becomes a step in the release
runbook, alongside the version bump — the notes ship with the code they describe, in the same
commit, so they cannot drift.

An entry for a version that does not exist yet is harmless (the app matches on the version it is
running). A missing entry is not: the panel must degrade to *"no notes for this version"* rather
than an error or an empty box.

## Verification

- unit: a version change since last launch shows the panel; an unchanged version does not;
- unit: a missing or malformed feed degrades to a plain message, never a crash or an empty modal;
- unit: the platform copy differs — Windows never renders an update button;
- manual, once: install a Store build over an older one and confirm the panel appears, since that
  is the case with no other signal.

## Explicitly not in scope

Forcing or scheduling updates. Nagging on a timer. Any change to how updates are actually
delivered on any platform — this spec adds information, not mechanism.
