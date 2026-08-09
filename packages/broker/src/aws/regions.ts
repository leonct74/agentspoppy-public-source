// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import type { ConnectedAccount } from "@agentspoppy/core";

/**
 * Standard commercial AWS regions, scanned in addition to the account's declared
 * regions. A poppy can pick ANY region at deploy time — independently of what
 * AgentsPoppy recorded for the account — so to find (and tear down) a connection's
 * footprint reliably we must look beyond `account.regions`. The tag-ownership check
 * makes a wide scan safe: only resources carrying this connection's app tag are ever
 * touched. Opt-in regions that aren't enabled simply error and are skipped.
 */
export const STANDARD_REGIONS = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1",
  "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-north-1", "eu-south-1",
  "ap-south-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "ap-northeast-2", "ap-northeast-3",
  "sa-east-1",
];

export function regionsFor(account: ConnectedAccount): string[] {
  const envFallback = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  return [...new Set([...account.regions, ...(envFallback ? [envFallback] : []), ...STANDARD_REGIONS])];
}
