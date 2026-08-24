// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { DirectoryView } from "./DirectoryView";
import { ApiError, broker, type DirectoryCatalogView, type DirectoryPoppy } from "../api/broker";

// The view must be testable without a live broker: stub the whole api module.
vi.mock("../api/broker", () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "ApiError";
    }
  }
  return {
    ApiError,
    broker: {
      directoryCatalog: vi.fn(),
      directoryInstall: vi.fn(),
      directoryUpdate: vi.fn(),
      directoryPreviewUpdate: vi.fn(),
      directoryApplyUpdate: vi.fn(),
      uninstallExtension: vi.fn(),
    },
  };
});

const preview = (over: Partial<import("../api/broker").UpdatePreview> = {}) => ({
  id: "com.mailpoppy.desktop",
  name: "MailPoppy",
  repo: "https://github.com/leonct74/mailpoppy",
  installedVersion: "1.2.2",
  version: "1.2.3",
  sha256: "abc123",
  installedGrants: ["ses — * (SendEmail)"] as string[],
  installedCapabilities: ["aws:credentials"] as string[],
  installedIsolation: "strict" as const,
  ...over,
});

const applyResult = (over: Partial<import("../api/broker").UpdateResult> = {}) => ({
  ok: true as const,
  extensionId: "com.mailpoppy.desktop",
  version: "1.2.3",
  scopeChanged: false,
  grantsAdded: [] as string[],
  grantsRemoved: [] as string[],
  capabilitiesAdded: [] as string[],
  capabilitiesRemoved: [] as string[],
  ...over,
});

const entry = (over: Partial<DirectoryPoppy> = {}): DirectoryPoppy => ({
  id: "com.mailpoppy.desktop",
  name: "MailPoppy",
  tagline: "Your own private email service",
  publisher: "AgentsPoppy",
  repo: "https://github.com/leonct74/mailpoppy",
  featured: true,
  version: "1.2.3",
  installed: false,
  updateAvailable: false,
  blocked: false,
  platform: { key: "darwin-arm64", available: true },
  ...over,
});

const catalog = (...poppies: DirectoryPoppy[]): DirectoryCatalogView => ({
  sourceUrl: "https://example.test/catalog.json",
  fetchedAt: new Date().toISOString(),
  poppies,
});

beforeEach(() => {
  vi.mocked(broker.directoryCatalog).mockReset();
  vi.mocked(broker.directoryInstall).mockReset();
  vi.mocked(broker.directoryUpdate).mockReset();
  vi.mocked(broker.directoryPreviewUpdate).mockReset();
  vi.mocked(broker.directoryApplyUpdate).mockReset();
  vi.mocked(broker.uninstallExtension).mockReset();
});
afterEach(cleanup);

describe("DirectoryView", () => {
  it("renders a listing with name, tagline, publisher, version, Featured badge and its source link", async () => {
    vi.mocked(broker.directoryCatalog).mockResolvedValue(catalog(entry()));
    render(<DirectoryView onInstalled={() => {}} onOpenPoppy={() => {}} />);

    expect(await screen.findByText("MailPoppy")).toBeTruthy();
    expect(screen.getByText("Your own private email service")).toBeTruthy();
    expect(screen.getByText("by AgentsPoppy")).toBeTruthy();
    expect(screen.getByText("v1.2.3")).toBeTruthy();
    expect(screen.getByText("Featured")).toBeTruthy();
    // The audit affordance: every listing links its open repository, in a new tab.
    const source = screen.getByText("Read the source").closest("a");
    expect(source?.getAttribute("href")).toBe("https://github.com/leonct74/mailpoppy");
    expect(source?.getAttribute("target")).toBe("_blank");
    expect(source?.getAttribute("rel")).toBe("noreferrer");
  });

  /**
   * The catalogue is where someone compares several poppies at once, so the rating has to be ON
   * the card — that's the whole point of collecting it. (Founder 2026-08-07.)
   */
  it("shows the star rating on a card, and says nothing at all when a poppy is unrated", async () => {
    vi.mocked(broker.directoryCatalog).mockResolvedValue(
      catalog(
        entry({ id: "com.rated.desktop", name: "RatedPoppy", rating: 4.3, ratingCount: 12 }),
        entry({ id: "com.new.desktop", name: "NewPoppy" }),
      ),
    );
    render(<DirectoryView onInstalled={() => {}} onOpenPoppy={() => {}} />);

    // The rated one shows the average and how many people it came from.
    const rating = await screen.findByTitle("4.3 out of 5, from 12 ratings");
    expect(rating.textContent).toContain("4.3");
    expect(rating.textContent).toContain("(12)");
    // Partial stars are drawn by clipping, so 4.3 is 86% of the row — not rounded to 4.
    const fill = rating.querySelector<HTMLElement>(".stars-fill");
    expect(fill?.style.width).toBe("86%");

    // The unrated one shows NO rating at all — a "0.0" would read as a bad score.
    expect(screen.queryByText(/0\.0/)).toBeNull();
    expect(screen.getAllByTitle(/out of 5/)).toHaveLength(1);
  });

  /**
   * agentspoppy://install deep links (the website's "Deploy for real" handoff) land here
   * with a focus id: the linked card is spotlit. An id the catalogue doesn't carry gets a
   * calm notice — the link is untrusted input from an arbitrary web page, never an error.
   */
  it("spotlights the deep-linked poppy's card", async () => {
    vi.mocked(broker.directoryCatalog).mockResolvedValue(catalog(entry()));
    render(<DirectoryView onInstalled={() => {}} onOpenPoppy={() => {}} focusId="com.mailpoppy.desktop" />);

    expect(await screen.findByText("MailPoppy")).toBeTruthy();
    const card = document.getElementById("poppy-card-com.mailpoppy.desktop");
    expect(card?.className).toContain("os-card--focus");
    expect(screen.queryByText(/isn't in the catalogue/)).toBeNull();
  });

  it("calmly flags a deep-linked id the catalogue doesn't have", async () => {
    vi.mocked(broker.directoryCatalog).mockResolvedValue(catalog(entry()));
    render(<DirectoryView onInstalled={() => {}} onOpenPoppy={() => {}} focusId="com.vanished.desktop" />);

    expect(await screen.findByText(/isn't in the catalogue right now/)).toBeTruthy();
    // The grid still renders — the notice never replaces the browsing surface.
    expect(screen.getByText("MailPoppy")).toBeTruthy();
  });

  it("installs on click, then reloads the catalog and tells the host", async () => {
    vi.mocked(broker.directoryCatalog)
      .mockResolvedValueOnce(catalog(entry()))
      .mockResolvedValueOnce(catalog(entry({ installed: true })));
    vi.mocked(broker.directoryInstall).mockResolvedValue({ ok: true, extensionId: "com.mailpoppy.desktop" });
    const onInstalled = vi.fn();
    render(<DirectoryView onInstalled={onInstalled} onOpenPoppy={() => {}} />);

    fireEvent.click(await screen.findByText("Install"));
    await waitFor(() => expect(onInstalled).toHaveBeenCalled());
    expect(broker.directoryInstall).toHaveBeenCalledWith("com.mailpoppy.desktop");
    // The reload flipped the card to its installed state.
    expect(broker.directoryCatalog).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Installed")).toBeTruthy();
  });

  it("shows Open on an installed listing and routes it to the poppy's tab", async () => {
    vi.mocked(broker.directoryCatalog).mockResolvedValue(catalog(entry({ installed: true })));
    const onOpenPoppy = vi.fn();
    render(<DirectoryView onInstalled={() => {}} onOpenPoppy={onOpenPoppy} />);

    expect(await screen.findByText("Installed")).toBeTruthy();
    fireEvent.click(screen.getByText("Open"));
    expect(onOpenPoppy).toHaveBeenCalledWith("com.mailpoppy.desktop");
  });

  it("shows the INSTALLED version, and an Update button + chip when the catalog has moved on", async () => {
    vi.mocked(broker.directoryCatalog).mockResolvedValue(
      catalog(entry({ installed: true, installedVersion: "1.2.2", version: "1.2.3", updateAvailable: true })),
    );
    render(<DirectoryView onInstalled={() => {}} onOpenPoppy={() => {}} />);

    // The chip tells the truth: what's installed, and what's waiting.
    expect(await screen.findByText("v1.2.2 installed")).toBeTruthy();
    expect(screen.getByText("v1.2.3 available")).toBeTruthy();
    // The action is Update, not a passive "Installed" badge.
    expect(screen.queryByText("Installed")).toBeNull();
    expect(screen.getByRole("button", { name: /Update to v1\.2\.3/ })).toBeTruthy();
  });

  it("a NOT-installed poppy offers Verify-with-your-AI-agent, and copying it puts the install audit on the clipboard", async () => {
    vi.mocked(broker.directoryCatalog).mockResolvedValue(catalog(entry({ installed: false })));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<DirectoryView onInstalled={() => {}} onOpenPoppy={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: /Verify this poppy with your AI agent/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const prompt = writeText.mock.calls[0][0] as string;
    expect(prompt).toContain("FIRST time");
    expect(prompt).toContain("CHECK FILESYSTEM CONFINEMENT");
    expect(await screen.findByText(/Prompt copied/)).toBeTruthy();
  });

  it("Update opens an AUDIT review that does NOT download — source diff + verify-with-agent", async () => {
    vi.mocked(broker.directoryCatalog).mockResolvedValue(
      catalog(entry({ installed: true, installedVersion: "1.2.2", version: "1.2.3", updateAvailable: true })),
    );
    vi.mocked(broker.directoryPreviewUpdate).mockResolvedValue(preview());
    render(<DirectoryView onInstalled={() => {}} onOpenPoppy={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: /Update to v1\.2\.3/ }));
    await waitFor(() => expect(broker.directoryPreviewUpdate).toHaveBeenCalledWith("com.mailpoppy.desktop"));

    // Reviewing reads the open source — the panel says nothing is downloaded yet.
    expect(await screen.findByText(/nothing is downloaded to your computer until you choose to install/i)).toBeTruthy();
    // A source-diff link to the open repo…
    const diff = screen.getByText(/See what changed/).closest("a");
    expect(diff?.getAttribute("href")).toBe("https://github.com/leonct74/mailpoppy/compare/v1.2.2...v1.2.3");
    // …the verify-with-your-agent affordance, and the consent button is DOWNLOAD & install.
    expect(screen.getByText("Verify this update with your AI agent")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Download & install v1\.2\.3/ })).toBeTruthy();
    // Nothing was downloaded/installed just by opening the review.
    expect(broker.directoryApplyUpdate).not.toHaveBeenCalled();
  });

  it("Download & install downloads the reviewed update, remounts the tab, refreshes", async () => {
    vi.mocked(broker.directoryCatalog)
      .mockResolvedValueOnce(
        catalog(entry({ installed: true, installedVersion: "1.2.2", version: "1.2.3", updateAvailable: true })),
      )
      .mockResolvedValueOnce(catalog(entry({ installed: true, installedVersion: "1.2.3", version: "1.2.3" })));
    vi.mocked(broker.directoryPreviewUpdate).mockResolvedValue(preview());
    vi.mocked(broker.directoryApplyUpdate).mockResolvedValue(applyResult());
    const onUpdated = vi.fn();
    const onInstalled = vi.fn();
    render(<DirectoryView onInstalled={onInstalled} onOpenPoppy={() => {}} onUpdated={onUpdated} />);

    fireEvent.click(await screen.findByRole("button", { name: /Update to v1\.2\.3/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Download & install v1\.2\.3/ }));

    await waitFor(() => expect(broker.directoryApplyUpdate).toHaveBeenCalledWith("com.mailpoppy.desktop"));
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith("com.mailpoppy.desktop"));
    expect(onInstalled).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText("v1.2.3 installed")).toBeTruthy());
    expect(screen.getByText("Installed")).toBeTruthy();
  });

  it("shows an animated spinner + reassuring progress WHILE the update downloads (not a dead button)", async () => {
    vi.mocked(broker.directoryCatalog).mockResolvedValue(
      catalog(entry({ installed: true, installedVersion: "1.2.2", version: "1.2.3", updateAvailable: true })),
    );
    vi.mocked(broker.directoryPreviewUpdate).mockResolvedValue(preview());
    // Hold the apply in-flight so we can observe the busy UI (a real download can take a minute).
    let resolveApply!: (v: ReturnType<typeof applyResult>) => void;
    vi.mocked(broker.directoryApplyUpdate).mockReturnValue(new Promise((r) => (resolveApply = r)));
    render(<DirectoryView onInstalled={() => {}} onOpenPoppy={() => {}} onUpdated={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: /Update to v1\.2\.3/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Download & install v1\.2\.3/ }));

    // Responsive feedback while in flight: an animated brand spinner, a status that sets time
    // expectations, and a disabled consent button reading progress — never a frozen "Downloading…".
    expect(await screen.findByText(/this can take a minute/i)).toBeTruthy();
    expect(document.querySelector(".poppy-spinner")).toBeTruthy();
    const btn = screen.getByRole("button", { name: /Downloading/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    resolveApply(applyResult()); // let it finish — the in-flight UI must then clear
    await waitFor(() => expect(screen.queryByText(/this can take a minute/i)).toBeNull());
    expect(document.querySelector(".poppy-spinner")).toBeNull();
  });

  it("after install, surfaces a scope change that will need re-approval", async () => {
    vi.mocked(broker.directoryCatalog)
      .mockResolvedValueOnce(
        catalog(entry({ installed: true, installedVersion: "1.2.2", version: "1.2.3", updateAvailable: true })),
      )
      .mockResolvedValueOnce(catalog(entry({ installed: true, installedVersion: "1.2.3", version: "1.2.3" })));
    vi.mocked(broker.directoryPreviewUpdate).mockResolvedValue(preview());
    vi.mocked(broker.directoryApplyUpdate).mockResolvedValue(
      applyResult({ scopeChanged: true, grantsAdded: ["s3 — arn:aws:s3:::other* (GetObject)"] }),
    );
    render(<DirectoryView onInstalled={() => {}} onOpenPoppy={() => {}} onUpdated={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: /Update to v1\.2\.3/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Download & install v1\.2\.3/ }));
    expect(await screen.findByText(/asks for new access.*re-approve it the next time it runs/i)).toBeTruthy();
  });

  it("shows plain Installed (no Update) when the installed version matches the catalog", async () => {
    vi.mocked(broker.directoryCatalog).mockResolvedValue(
      catalog(entry({ installed: true, installedVersion: "1.2.3", version: "1.2.3" })),
    );
    render(<DirectoryView onInstalled={() => {}} onOpenPoppy={() => {}} />);

    expect(await screen.findByText("Installed")).toBeTruthy();
    expect(screen.getByText("v1.2.3 installed")).toBeTruthy();
    expect(screen.queryByText(/Update to/)).toBeNull();
  });

  it("disables install when there's no package for this computer", async () => {
    vi.mocked(broker.directoryCatalog).mockResolvedValue(
      catalog(entry({ platform: { key: "linux-x64", available: false } })),
    );
    render(<DirectoryView onInstalled={() => {}} onOpenPoppy={() => {}} />);

    const btn = (await screen.findByText("Not yet available for this computer")).closest("button");
    expect(btn?.disabled).toBe(true);
    expect(screen.queryByText("Install")).toBeNull();
  });

  it("calls out a blocked listing instead of offering Install", async () => {
    vi.mocked(broker.directoryCatalog).mockResolvedValue(catalog(entry({ blocked: true })));
    render(<DirectoryView onInstalled={() => {}} onOpenPoppy={() => {}} />);

    expect(await screen.findByText("Blocked on this computer")).toBeTruthy();
    expect(screen.queryByText("Install")).toBeNull();
  });

  it("surfaces the broker's plain-language install failure and keeps the card usable for a retry", async () => {
    vi.mocked(broker.directoryCatalog).mockResolvedValue(catalog(entry()));
    vi.mocked(broker.directoryInstall).mockRejectedValue(
      new ApiError(
        400,
        "bad_request",
        "This package doesn't match what the directory expected — the download may be corrupted or tampered with. Nothing was installed.",
      ),
    );
    render(<DirectoryView onInstalled={() => {}} onOpenPoppy={() => {}} />);

    fireEvent.click(await screen.findByText("Install"));
    expect(
      await screen.findByText(
        "This package doesn't match what the directory expected — the download may be corrupted or tampered with. Nothing was installed.",
      ),
    ).toBeTruthy();
    // The button is back to Install — the user can try again.
    expect((screen.getByText("Install").closest("button") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a friendly unreachable state with a working Retry", async () => {
    vi.mocked(broker.directoryCatalog)
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(catalog(entry()));
    render(<DirectoryView onInstalled={() => {}} onOpenPoppy={() => {}} />);

    expect(
      await screen.findByText(
        "Couldn't load Poppies — check your internet connection and try again.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Retry"));
    expect(await screen.findByText("MailPoppy")).toBeTruthy();
  });

  it("keeps sideloading honest in the footer: distribution outside the directory stays open", async () => {
    vi.mocked(broker.directoryCatalog).mockResolvedValue(catalog());
    render(<DirectoryView onInstalled={() => {}} onOpenPoppy={() => {}} />);
    expect(await screen.findByText(/outside this catalog/)).toBeTruthy();
  });

  it("uninstalls behind a two-step confirm — cloud-untouched copy, then removal", async () => {
    vi.mocked(broker.directoryCatalog)
      .mockResolvedValueOnce(catalog(entry({ installed: true })))
      .mockResolvedValueOnce(catalog(entry({ installed: false })));
    vi.mocked(broker.uninstallExtension).mockResolvedValue({ ok: true, extensionId: "com.mailpoppy.desktop" });
    const onUninstalled = vi.fn();
    render(<DirectoryView onInstalled={() => {}} onOpenPoppy={() => {}} onUninstalled={onUninstalled} />);

    // First click only reveals the plain-language confirm — nothing happens yet.
    fireEvent.click(await screen.findByText("Uninstall"));
    expect(broker.uninstallExtension).not.toHaveBeenCalled();
    expect(screen.getByText(/stays\s+untouched and keeps working/)).toBeTruthy();

    // "Keep it" backs out cleanly…
    fireEvent.click(screen.getByText("Keep it"));
    expect(screen.queryByText(/stays\s+untouched/)).toBeNull();

    // …and confirming actually removes it and tells the host.
    fireEvent.click(screen.getByText("Uninstall"));
    fireEvent.click(screen.getByText("Uninstall")); // the confirm block's primary
    await waitFor(() => expect(broker.uninstallExtension).toHaveBeenCalledWith("com.mailpoppy.desktop"));
    await waitFor(() => expect(onUninstalled).toHaveBeenCalledWith("com.mailpoppy.desktop"));
  });

  it("shows the poppy's real app icon on its card, monogram only as the fallback", async () => {
    const ICON = `data:image/png;base64,${btoa("png!")}`;
    vi.mocked(broker.directoryCatalog).mockResolvedValue(
      catalog(entry({ icon: ICON }), entry({ id: "com.example.bare", name: "Bare-Poppy", icon: undefined })),
    );
    const { container } = render(
      <DirectoryView onInstalled={() => {}} onOpenPoppy={() => {}} />,
    );
    await screen.findByText("MailPoppy");
    const img = container.querySelector(".os-avatar img") as HTMLImageElement | null;
    expect(img?.getAttribute("src")).toBe(ICON);
    // The icon-less listing still gets its letter monogram, never a broken image.
    expect(screen.getByText("BA")).toBeTruthy();
    expect(container.querySelectorAll(".os-avatar img")).toHaveLength(1);
  });
});
