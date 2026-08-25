// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import {
  fetchReleaseNotes,
  noteFor,
  notesSince,
  shouldAnnounce,
  lastSeenVersion,
  recordSeenVersion,
  isWindows,
  type ReleaseNote,
} from "./whatsNew";

const NOTES: ReleaseNote[] = [
  { version: "0.3.5", date: "2026-08-24", summary: "Confined by default.", changes: ["a"] },
  { version: "0.3.4", date: "2026-08-22", summary: "Windows update fix.", changes: ["b"], windowsOnly: true },
  { version: "0.3.3", date: "2026-08-12", summary: "Setup wizard.", changes: ["c"] },
  { version: "0.3.2", date: "2026-08-11", summary: "Policy link fix.", changes: ["d"] },
];

function fakeFetch(body: unknown, ok = true): typeof fetch {
  return (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
}

describe("shouldAnnounce", () => {
  it("announces when the running version differs from the last seen one", () => {
    expect(shouldAnnounce("0.3.3", "0.3.5")).toBe(true);
  });

  it("stays quiet on an unchanged version", () => {
    expect(shouldAnnounce("0.3.5", "0.3.5")).toBe(false);
  });

  // A fresh install has changed nothing for this user; greeting them with release notes
  // for a version they never ran is noise.
  it("stays quiet on a first run", () => {
    expect(shouldAnnounce(null, "0.3.5")).toBe(false);
  });

  it("stays quiet when the version cannot be read (plain-browser dev)", () => {
    expect(shouldAnnounce("0.3.3", null)).toBe(false);
  });
});

describe("notesSince", () => {
  // Someone who skips versions should read everything they missed. This matters most on
  // Windows, where the Store may move them several versions with no announcement.
  it("returns every version the user skipped", () => {
    expect(notesSince("0.3.2", "0.3.5", NOTES).map((n) => n.version)).toEqual(["0.3.5", "0.3.4", "0.3.3"]);
  });

  it("returns just the current version when the last seen one is unknown", () => {
    expect(notesSince("0.2.0", "0.3.5", NOTES).map((n) => n.version)).toEqual(["0.3.5"]);
  });

  it("returns just the current version with no history", () => {
    expect(notesSince(null, "0.3.4", NOTES).map((n) => n.version)).toEqual(["0.3.4"]);
  });

  it("returns nothing when the versions match", () => {
    expect(notesSince("0.3.5", "0.3.5", NOTES)).toEqual([]);
  });

  // A downgrade must not replay the whole history as if it were new.
  it("returns nothing when the running version is older than the last seen one", () => {
    expect(notesSince("0.3.3", "0.3.5", NOTES).length).toBeGreaterThan(0);
    expect(notesSince("0.3.3", "0.3.3", NOTES)).toEqual([]);
  });

  it("returns nothing for a version the feed has never heard of", () => {
    expect(notesSince("0.3.3", "9.9.9", NOTES)).toEqual([]);
  });
});

describe("fetchReleaseNotes", () => {
  it("reads the releases array", async () => {
    const out = await fetchReleaseNotes(fakeFetch({ releases: NOTES }));
    expect(out.map((n) => n.version)).toEqual(["0.3.5", "0.3.4", "0.3.3", "0.3.2"]);
  });

  // Every failure path returns [], because the panel degrades to "no notes" rather than
  // an error. A release-notes feed must never be able to break the app.
  it("returns nothing on a failed request", async () => {
    expect(await fetchReleaseNotes(fakeFetch({}, false))).toEqual([]);
  });

  it("returns nothing when the body is not the expected shape", async () => {
    expect(await fetchReleaseNotes(fakeFetch({ releases: "nope" }))).toEqual([]);
  });

  it("drops malformed entries but keeps good ones", async () => {
    const out = await fetchReleaseNotes(fakeFetch({ releases: [NOTES[0], { version: 1 }, { nope: true }] }));
    expect(out.map((n) => n.version)).toEqual(["0.3.5"]);
  });

  it("returns nothing when the request throws", async () => {
    const throwing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchReleaseNotes(throwing)).toEqual([]);
  });
});

describe("noteFor", () => {
  it("finds a version", () => {
    expect(noteFor("0.3.3", NOTES)?.summary).toBe("Setup wizard.");
  });

  it("returns null for a version with no entry", () => {
    expect(noteFor("0.9.9", NOTES)).toBeNull();
  });
});

describe("seen-version storage", () => {
  it("round-trips", () => {
    const mem = new Map<string, string>();
    const store = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    };
    expect(lastSeenVersion(store)).toBeNull();
    recordSeenVersion("0.3.5", store);
    expect(lastSeenVersion(store)).toBe("0.3.5");
  });

  it("survives storage being unavailable", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(lastSeenVersion(blocked)).toBeNull();
    expect(() => recordSeenVersion("0.3.5", blocked)).not.toThrow();
  });
});

describe("isWindows", () => {
  it("detects Windows", () => {
    expect(isWindows("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(true);
  });

  it("does not match macOS", () => {
    expect(isWindows("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe(false);
  });
});
