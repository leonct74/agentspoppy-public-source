// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * "What's new" — what the version you are now running actually changed.
 *
 * Opens by itself once, the first time the app starts on a version the user has not run
 * before, and can be reopened from the version in the footer.
 *
 * This is the only place a Microsoft Store user learns anything: the Store updates the app
 * silently, on its own schedule, with no prompt and no way to decline. Elsewhere it
 * complements the update banner — the banner says what is coming, this says what arrived.
 */
import { useEffect, useState } from "react";
import {
  currentVersion,
  fetchReleaseNotes,
  lastSeenVersion,
  notesSince,
  recordSeenVersion,
  shouldAnnounce,
  type ReleaseNote,
} from "../lib/whatsNew";
import { Icon } from "./Icon";

export interface WhatsNewProps {
  /** Injected in tests; defaults read the real version and feed. */
  readVersion?: typeof currentVersion;
  loadNotes?: typeof fetchReleaseNotes;
  readSeen?: typeof lastSeenVersion;
  writeSeen?: typeof recordSeenVersion;
}

export function WhatsNew({
  readVersion = currentVersion,
  loadNotes = fetchReleaseNotes,
  readSeen = lastSeenVersion,
  writeSeen = recordSeenVersion,
}: WhatsNewProps) {
  const [version, setVersion] = useState<string | null>(null);
  const [notes, setNotes] = useState<ReleaseNote[]>([]);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // The version the user last ran, captured BEFORE it is overwritten below. Reading it
  // back during render would return the version we just wrote, so "you skipped 0.3.3 and
  // 0.3.4" would silently collapse to "here is 0.3.5".
  const [seenBefore, setSeenBefore] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const v = await readVersion();
      if (cancelled || !v) return;
      const seen = readSeen();
      const all = await loadNotes();
      if (cancelled) return;
      setVersion(v);
      setNotes(all);
      setSeenBefore(seen);
      setLoaded(true);
      if (shouldAnnounce(seen, v)) setOpen(true);
      // Recorded whether or not there are notes to show: the point is that this version
      // has been seen, so a missing entry cannot make the panel reappear every launch.
      writeSeen(v);
    })();
    return () => {
      cancelled = true;
    };
  }, [readVersion, loadNotes, readSeen, writeSeen]);

  if (!loaded || !version) return null;

  // The panel lists EVERY release, not just the ones since last launch. Showing only
  // what changed answers "what am I accepting?" and nothing else — reopen it a day later
  // and the history is gone, so there is no way to look back at what a version did. So:
  // the whole list, with the releases this user has not seen yet marked.
  // Nothing is "new" when this version has already been seen, or on a first run. Passing
  // null to notesSince here would return the CURRENT release and badge it New to someone
  // who has been running it for a week.
  const unseen =
    seenBefore && seenBefore !== version
      ? new Set(notesSince(seenBefore, version, notes).map((n) => n.version))
      : new Set<string>();

  return (
    <>
      <button className="btn link whats-new__version" onClick={() => setOpen(true)}>
        AgentsPoppy {version}
      </button>

      {open && (
        <div className="whats-new" role="dialog" aria-label={`What's new in AgentsPoppy ${version}`}>
          <div className="whats-new__head">
            <h2>
              <Icon name="download" /> What&rsquo;s new
            </h2>
            <button className="btn link" onClick={() => setOpen(false)} aria-label="Close">
              Close
            </button>
          </div>

          {notes.length === 0 ? (
            <p className="whats-new__empty">
              You&rsquo;re on AgentsPoppy {version}. There are no notes for this version.
            </p>
          ) : (
            notes.map((n) => (
              <section
                key={n.version}
                className={`whats-new__release${unseen.has(n.version) ? " is-new" : ""}`}
              >
                <h3>
                  {n.version}
                  {unseen.has(n.version) && <span className="whats-new__badge">New</span>}
                  {n.version === version && <span className="whats-new__badge is-current">You have this</span>}
                  {n.date ? <span className="whats-new__date">{n.date}</span> : null}
                </h3>
                <p className="whats-new__summary">{n.summary}</p>
                <ul>
                  {n.changes.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      )}
    </>
  );
}
