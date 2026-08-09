// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { Icon, type IconName } from "./Icon";

interface Pillar {
  icon: IconName;
  title: string;
  body: string;
}

/** The three promises AgentsPoppy makes — shown wherever we ask for trust. */
const PILLARS: Pillar[] = [
  {
    icon: "lock",
    title: "Runs on your machine",
    body: "Your AWS keys never leave this computer. No server, no hosted account, nothing to breach.",
  },
  {
    icon: "shield",
    title: "Least privilege",
    body: "Each app gets only the access you approve — scoped to resources tagged as its own.",
  },
  {
    icon: "power",
    title: "Revocable anytime",
    body: "Pause or revoke in one click. Credentials are short-lived, so access stops within the hour.",
  },
];

export function TrustPillars() {
  return (
    <div className="pillars">
      {PILLARS.map((p) => (
        <div key={p.title} className="pillar">
          <div className="pillar-ico">
            <Icon name={p.icon} />
          </div>
          <strong>{p.title}</strong>
          <p>{p.body}</p>
        </div>
      ))}
    </div>
  );
}
