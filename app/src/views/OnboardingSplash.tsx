// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { PoppyMark } from "../components/PoppyMark";
import { TrustPillars } from "../components/TrustPillars";

const SLIDES = 2;
const AUTO_MS = 15000;

/**
 * The intro overlay. Shown on EVERY launch (not just first run) and closed by hand,
 * so its trust message always lands — it floats ABOVE the app as a dismissible
 * overlay; close it (or, when not yet connected, press Connect) to reveal the shell.
 * The narrative is a two-slide carousel: (1) the pitch + the three promises, (2) how
 * it works. The carousel can be swiped/clicked and also auto-advances every 15s.
 *
 * `connected` adapts the primary action: a returning, already-connected user gets a
 * plain "Continue" (just dismiss) instead of the first-run "Connect your AWS" CTA.
 */
export function OnboardingSplash({
  connected = false,
  onConnect,
  onClose,
}: {
  connected?: boolean;
  onConnect: () => void;
  onClose: () => void;
}) {
  const [slide, setSlide] = useState(0);
  const slideRef = useRef(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const goTo = useCallback((i: number, smooth = true) => {
    const n = ((i % SLIDES) + SLIDES) % SLIDES;
    slideRef.current = n;
    setSlide(n);
    const el = trackRef.current;
    if (el && typeof el.scrollTo === "function") {
      el.scrollTo({ left: n * el.clientWidth, behavior: smooth ? "smooth" : "auto" });
    }
  }, []);

  const startAuto = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => goTo(slideRef.current + 1), AUTO_MS);
  }, [goTo]);

  useEffect(() => {
    startAuto();
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [startAuto]);

  // Esc dismisses the overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Manual nav: jump there and restart the auto timer so it doesn't fight the user.
  const nav = (i: number) => {
    goTo(i);
    startAuto();
  };

  // Keep the dots in sync when the user swipes/scrolls the track directly.
  const onScroll = () => {
    const el = trackRef.current;
    if (!el || !el.clientWidth) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    if (i !== slideRef.current) {
      slideRef.current = i;
      setSlide(i);
    }
  };

  return (
    <div className="splash-overlay" role="dialog" aria-modal="true" aria-label="Welcome to AgentsPoppy">
      <div className="splash-backdrop" onClick={onClose} />
      <section className="splash">
        <button className="splash-close" onClick={onClose} aria-label="Close intro">
          <Icon name="x" />
        </button>

        <div className="splash-brand">
          <span className="splash-logo-wrap" aria-hidden="true">
            <PoppyMark className="splash-logo" />
          </span>
          <h1>AgentsPoppy</h1>
          <p className="splash-tagline">The gatekeeper between your apps and your own AWS.</p>
        </div>

        <span className="noadmin-badge">
          <Icon name="lock" /> Never asks for or uses admin access
        </span>

        <div className="carousel">
          <div className="carousel-track" ref={trackRef} onScroll={onScroll}>
            {/* Slide 1 — the pitch + the three promises. */}
            <div className="carousel-slide">
              <p className="splash-lead">
                A one-time setup. You'll create a single role in your account that AgentsPoppy can assume to
                give each app scoped, short-lived credentials — so nothing here ever stores a long-lived AWS
                key, and you can switch it all off whenever you like.
              </p>
              <TrustPillars />
            </div>

            {/* Slide 2 — how it works. */}
            <div className="carousel-slide">
              <div className="how">
                <h3>How it works</h3>
                <ol className="how-steps">
                  <li>
                    <span className="how-n">1</span>
                    <div>
                      <strong>Connect AWS</strong>
                      <p className="muted">
                        Create one role AgentsPoppy can assume, plus a non-admin operator. You deploy it, so
                        you stay in control — admin is never handed over.
                      </p>
                    </div>
                  </li>
                  <li>
                    <span className="how-n">2</span>
                    <div>
                      <strong>Approve apps</strong>
                      <p className="muted">
                        When an app asks for access, you see exactly what it wants in plain language before
                        saying yes.
                      </p>
                    </div>
                  </li>
                  <li>
                    <span className="how-n">3</span>
                    <div>
                      <strong>Watch &amp; revoke</strong>
                      <p className="muted">
                        See everything each app built in your cloud — and pause, revoke, or tear it all down
                        whenever you want.
                      </p>
                    </div>
                  </li>
                </ol>
              </div>
            </div>
          </div>
        </div>

        <div className="carousel-dots" role="tablist" aria-label="Intro slides">
          {Array.from({ length: SLIDES }, (_, i) => (
            <button
              key={i}
              className={i === slide ? "dot active" : "dot"}
              onClick={() => nav(i)}
              role="tab"
              aria-selected={i === slide}
              aria-label={`Slide ${i + 1}`}
            />
          ))}
        </div>

        <div className="splash-cta">
          {connected ? (
            <button className="btn btn-primary btn-lg" onClick={onClose}>
              Continue
            </button>
          ) : (
            <button className="btn btn-primary btn-lg" onClick={onConnect}>
              Connect your AWS
            </button>
          )}
          <p className="micro muted">
            {connected
              ? "Scoped, short-lived credentials · nothing leaves this machine · never needs admin"
              : "One-time setup · about 3 minutes · nothing leaves this machine · never needs admin"}
          </p>
        </div>
      </section>
    </div>
  );
}
