// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The AWS regions offered in the sidebar region switcher. Mirrors the broker's STANDARD_REGIONS
 * (packages/broker/src/aws/regions.ts) — keep them in sync. Labelled so the dropdown reads in
 * plain language ("Ireland") rather than only the code ("eu-west-1").
 */
export interface AwsRegion {
  id: string;
  label: string;
}

export const AWS_REGIONS: AwsRegion[] = [
  { id: "us-east-1", label: "N. Virginia" },
  { id: "us-east-2", label: "Ohio" },
  { id: "us-west-1", label: "N. California" },
  { id: "us-west-2", label: "Oregon" },
  { id: "ca-central-1", label: "Canada" },
  { id: "eu-west-1", label: "Ireland" },
  { id: "eu-west-2", label: "London" },
  { id: "eu-west-3", label: "Paris" },
  { id: "eu-central-1", label: "Frankfurt" },
  { id: "eu-north-1", label: "Stockholm" },
  { id: "eu-south-1", label: "Milan" },
  { id: "ap-south-1", label: "Mumbai" },
  { id: "ap-southeast-1", label: "Singapore" },
  { id: "ap-southeast-2", label: "Sydney" },
  { id: "ap-northeast-1", label: "Tokyo" },
  { id: "ap-northeast-2", label: "Seoul" },
  { id: "ap-northeast-3", label: "Osaka" },
  { id: "sa-east-1", label: "São Paulo" },
];

/** "eu-west-1" → "eu-west-1 · Ireland" (or just the id if we don't have a label). */
export function regionLabel(id: string): string {
  const r = AWS_REGIONS.find((x) => x.id === id);
  return r ? `${r.id} · ${r.label}` : id;
}
