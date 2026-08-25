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

  const shown = open ? notesSince(seenBefore === version ? null : seenBefore, version, notes) : [];

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

          {shown.length === 0 ? (
            <p className="whats-new__empty">
              You&rsquo;re on AgentsPoppy {version}. There are no notes for this version.
            </p>
          ) : (
            shown.map((n) => (
              <section key={n.version} className="whats-new__release">
                <h3>
                  {n.version}
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
