// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0
//
// Pieces shared by BOTH onboarding surfaces — the wizard (SetupWizard) and the
// pro stepper (ConnectAwsView). Lives in its own module so neither view imports
// the other.

import { useState, type ReactNode } from "react";
import accessPolicy from "../assets/access-policy.json";

/**
 * The policy text ships INSIDE the app so onboarding never depends on a network link.
 * (On 2026-08-11 the link pointed into the private monorepo and 404'd for every user,
 * stranding them mid-setup — a copy button can't 404.) Kept in sync from
 * infra/policies/agentspoppy-access-policy.json; release-check verifies they match.
 */
export const ACCESS_POLICY_JSON = JSON.stringify(accessPolicy, null, 2);

export const AWS_FREE_TIER_URL = "https://aws.amazon.com/free";
export const AWS_SIGNUP_URL = "https://signin.aws.amazon.com/signup?request_type=register";
export const AWS_CLI_URL = "https://aws.amazon.com/cli/";
export const IAM_USERS_URL = "https://console.aws.amazon.com/iam/home#/users";
// MUST point at the PUBLIC mirror. This monorepo is private forever (it carries the web
// and mobile apps), so a link into it 404s for every user and strands them mid-onboarding —
// exactly what happened on 2026-08-11. Rule: fetch any user-facing URL with NO credentials
// and require a 200 before shipping it (the same trap that broke MailPoppy's installs).
export const ACCESS_POLICY_URL =
  "https://github.com/leonct74/agentspoppy-public-source/blob/main/infra/policies/agentspoppy-access-policy.json";

/**
 * The regions we offer, with the flag + place name a newcomer recognises — "eu-west-1"
 * means nothing to someone connecting AWS for the first time; "🇮🇪 Europe (Ireland)" does.
 */
export const REGION_CHOICES: { id: string; flag: string; place: string }[] = [
  { id: "us-east-1", flag: "🇺🇸", place: "US East (N. Virginia)" },
  { id: "us-east-2", flag: "🇺🇸", place: "US East (Ohio)" },
  { id: "us-west-2", flag: "🇺🇸", place: "US West (Oregon)" },
  { id: "eu-west-1", flag: "🇮🇪", place: "Europe (Ireland)" },
  { id: "eu-central-1", flag: "🇩🇪", place: "Europe (Frankfurt)" },
  { id: "eu-west-2", flag: "🇬🇧", place: "Europe (London)" },
  { id: "ap-southeast-1", flag: "🇸🇬", place: "Asia Pacific (Singapore)" },
  { id: "ap-southeast-2", flag: "🇦🇺", place: "Asia Pacific (Sydney)" },
  { id: "ap-northeast-1", flag: "🇯🇵", place: "Asia Pacific (Tokyo)" },
];

export const COMMON_REGIONS = REGION_CHOICES.map((r) => r.id);

/**
 * Best-guess CLOSEST region from the machine's IANA timezone — a suggestion the
 * region screen labels "Closest to you", never an auto-pick: latency is why the
 * closest region is usually right, but residency is the user's call. Pure, so the
 * mapping is testable; unknown zones fall back to us-east-1 (the most connected
 * default) without claiming closeness.
 */
export function suggestRegion(tz: string): string {
  if (/^Europe\/(London|Belfast)/.test(tz)) return "eu-west-2";
  if (/^Europe\/(Dublin|Lisbon)/.test(tz)) return "eu-west-1";
  if (/^Europe\//.test(tz)) return "eu-central-1";
  if (/^Australia\//.test(tz)) return "ap-southeast-2";
  if (/^Asia\/(Tokyo|Seoul|Sapporo)/.test(tz)) return "ap-northeast-1";
  if (/^Asia\//.test(tz)) return "ap-southeast-1";
  if (/^America\/(Los_Angeles|Vancouver|Tijuana|Phoenix|Denver|Edmonton|Boise)/.test(tz)) return "us-west-2";
  if (/^America\/(Chicago|Winnipeg|Mexico_City|Indiana|Detroit)/.test(tz)) return "us-east-2";
  if (/^America\//.test(tz)) return "us-east-1";
  if (/^Africa\//.test(tz)) return "eu-west-1";
  return "us-east-1";
}

export const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function openExternal(url: string): void {
  if (isTauri()) {
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("plugin:opener|open_url", { url, with: null }))
      .catch(() => {});
  } else {
    window.open(url, "_blank", "noopener");
  }
}

export function ExtLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        if (isTauri()) {
          e.preventDefault();
          openExternal(href);
        }
      }}
    >
      {children}
    </a>
  );
}

/**
 * Copy the access policy straight from the app. This is the PRIMARY way to get the policy:
 * the GitHub link beside it is a convenience, and on 2026-08-11 that link (pointing into
 * the private monorepo) 404'd and stranded users mid-onboarding. A button that reads from
 * the bundle cannot 404.
 */
export function CopyPolicyButton({ primary }: { primary?: boolean } = {}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      className={primary ? "btn btn-primary btn-sm" : "btn btn-sm"}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(ACCESS_POLICY_JSON);
          setState("copied");
          setTimeout(() => setState("idle"), 2500);
        } catch {
          setState("failed");
        }
      }}
    >
      {state === "copied" ? "Copied ✓" : state === "failed" ? "Press ⌘C to copy" : "Copy the policy"}
    </button>
  );
}
