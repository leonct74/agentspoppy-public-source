// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The hand-written half of Panel 3 (docs/specs/permission-presentation.md): one sentence per
 * AWS service saying what that service CONTROLS, so the consequence of a permission there is
 * legible to someone who has never opened the AWS console. "Mail receiving rules apply to the
 * whole account" is a fact about SES that no amount of policy analysis produces — someone has
 * to write it, and write it honestly.
 *
 * Standing: these are PLATFORM-authored facts about AWS itself — not about any poppy, and not
 * a developer's claim. They must stay true for every poppy and every grant shape, which is why
 * they describe the service and never the caller ("a changed record can…", never "this poppy
 * will…"). Anything poppy-specific belongs in the grant's `reason`, which is labelled as the
 * developer's words.
 *
 * Coverage is deliberately partial: a service nobody's stake section shows needs no sentence,
 * and a missing entry renders as nothing — never as filler. When a new poppy brings a new
 * service into a stake section, write its sentence here; the fleet test names the services
 * that must be covered.
 */
const SERVICE_STAKES: Record<string, string> = {
  iam:
    "IAM is where AWS keeps who can do what. A role created here is a new identity in your account, and its permissions — not its name — decide what it can reach.",
  "cognito-idp":
    "Cognito holds sign-in directories: the user accounts, and the door your apps' users walk through. Changing a directory can lock people out or let new ones in.",
  ses:
    "SES is your account's mail system, and receiving rules are account-wide: one active rule set decides where incoming mail for every domain goes, so a change here can redirect or drop mail for all of them.",
  route53:
    "Route 53 is your DNS — what your domain names point at. A changed record can take a live site down, or send its visitors or its mail somewhere else.",
  guardduty:
    "GuardDuty is a security service; its malware-protection plans decide what gets scanned. Removing or changing a plan quietly reduces that coverage.",
  amplify:
    "Amplify hosts websites. Changing an app or its deployments changes what visitors to that site actually see.",
  ec2:
    "EC2 is servers, networks and disks. Listing them reveals the shape of what you run; the reads themselves change nothing.",
  s3:
    "S3 holds your stored files. Listing buckets shows their names only, never what is inside them.",
  sts:
    "STS only answers who a credential belongs to — it grants nothing by itself.",
  cloudformation:
    "CloudFormation deploys whole stacks of resources from templates. Validating a template reads it and touches nothing.",
  pricing:
    "AWS's price list is a public catalogue — the same numbers anyone can look up, nothing from your account.",
  bedrock:
    "Bedrock runs AI models. An availability check reveals which models are switched on, not what anyone asks them.",
};

/** The service-level context sentence, or undefined — a missing entry must render as nothing. */
export function serviceStake(service: string): string | undefined {
  return SERVICE_STAKES[service.toLowerCase()];
}
