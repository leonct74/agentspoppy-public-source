// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Bootstrap-time AWS checks, behind an injectable seam.
 *
 * - `getCallerIdentity` answers "are my operator credentials working, and who am
 *   I?" — also supplying the account id that goes into the role's trust policy.
 * - `verifyRole` confirms the pasted role actually exists and is assumable, so
 *   the user gets a clear green/red before any poppy tries to use it.
 *
 * The SDK is loaded lazily inside the default impl; the stub keeps tests/demo
 * offline.
 */
import { operatorCredentials, writeAgentsPoppyProfile, type AwsKeyInput } from "./credentials";
import { TEMPLATE_VERSION } from "./role-template";
import {
  readSetupStack,
  runBootstrap,
  sdkBootstrapGateway,
  type BootstrapInput,
  type BootstrapResult,
} from "./bootstrap";
import { setupVersionStatus, type SetupVersionStatus } from "./setup-version";

export interface CallerIdentity {
  accountId: string;
  arn: string;
  userId: string;
}

export type RoleProbeResult = { ok: true; assumedArn: string } | { ok: false; reason: string };

export interface AwsBootstrap {
  getCallerIdentity(region?: string): Promise<CallerIdentity>;
  verifyRole(roleArn: string, region: string): Promise<RoleProbeResult>;
  /** Persist pasted keys to the dedicated `agentspoppy` profile (the in-app entry path). */
  writeOperatorCredentials(input: AwsKeyInput): Promise<void>;
  /**
   * AUTOMATED setup: deploy the broker role + non-admin operator with elevated
   * setup creds (in-memory only), then write the resulting operator key. Idempotent
   * / resumable — see {@link runBootstrap}.
   */
  deployBootstrap(input: BootstrapInput): Promise<BootstrapResult>;
  /**
   * Is the setup deployed in the user's account the one this host expects? The guardrails
   * live in THEIR AWS, so a tightened one changes nothing until they re-apply — and nothing
   * else tells them to. Read-only; needs no permission the operator doesn't already hold.
   */
  readSetupVersion(region?: string): Promise<SetupVersionStatus>;
}

function regionOrDefault(region?: string): string {
  return region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
}

/** Real bootstrap backed by STS + the operator's local credential chain. */
export function sdkAwsBootstrap(): AwsBootstrap {
  async function stsClient(region: string) {
    const { STSClient } = await import("@aws-sdk/client-sts");
    return new STSClient({ region, credentials: await operatorCredentials() });
  }

  return {
    async writeOperatorCredentials(input) {
      writeAgentsPoppyProfile(input);
    },

    async deployBootstrap(input) {
      return runBootstrap(sdkBootstrapGateway(input.region, input.setup), input);
    },

    async readSetupVersion(region) {
      const r = regionOrDefault(region);
      return setupVersionStatus(await readSetupStack(sdkBootstrapGateway(r), r));
    },

    async getCallerIdentity(region) {
      const { GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
      const sts = await stsClient(regionOrDefault(region));
      const out = await sts.send(new GetCallerIdentityCommand({}));
      if (!out.Account || !out.Arn || !out.UserId) {
        throw new Error("STS GetCallerIdentity returned an incomplete identity");
      }
      return { accountId: out.Account, arn: out.Arn, userId: out.UserId };
    },

    async verifyRole(roleArn, region) {
      try {
        const { AssumeRoleCommand } = await import("@aws-sdk/client-sts");
        const sts = await stsClient(regionOrDefault(region));
        const out = await sts.send(
          new AssumeRoleCommand({
            RoleArn: roleArn,
            RoleSessionName: "agentspoppy-verify",
            DurationSeconds: 900,
          }),
        );
        const assumedArn = out.AssumedRoleUser?.Arn;
        if (!assumedArn) return { ok: false, reason: "AssumeRole succeeded but returned no assumed identity" };
        return { ok: true, assumedArn };
      } catch (err) {
        return { ok: false, reason: (err as Error).message };
      }
    },
  };
}

// Matches the canonical demo/test account id ("123456789012") — teardown cross-checks the
// caller's account against the connection's, so the stub must agree with what tests/demo link.
const STUB_IDENTITY: CallerIdentity = {
  accountId: "123456789012",
  arn: "arn:aws:iam::123456789012:user/stub-operator",
  userId: "STUBOPERATOR",
};

/**
 * Offline stub for tests + demo mode.
 *
 * `failFirstN` lets the demo reproduce the brand-new-user experience: the first
 * N identity probes fail (as if no AWS credentials were configured yet), then
 * succeed — mirroring a user who creates an account / access key and clicks
 * "check again". Default 0 → always succeeds (the normal demo happy path).
 */
export class StubAwsBootstrap implements AwsBootstrap {
  private probes = 0;

  constructor(
    private readonly identity: CallerIdentity = STUB_IDENTITY,
    private readonly failFirstN = 0,
  ) {}

  async getCallerIdentity(): Promise<CallerIdentity> {
    if (this.probes++ < this.failFirstN) {
      throw new Error("No AWS credentials found on this machine (simulated new user).");
    }
    return this.identity;
  }
  async verifyRole(roleArn: string): Promise<RoleProbeResult> {
    return { ok: true, assumedArn: `${roleArn}/agentspoppy-verify` };
  }
  async readSetupVersion(): Promise<SetupVersionStatus> {
    // Demo/test: the simulated setup is always the one this build ships, so the demo
    // never shows a staleness banner it can't act on.
    return setupVersionStatus({ ok: true, outputs: { TemplateVersion: String(TEMPLATE_VERSION) } });
  }
  async writeOperatorCredentials(): Promise<void> {
    // Demo/test: don't touch ~/.aws. Simulate a successful save so the next
    // identity probe resolves (as if the user had just configured credentials).
    this.probes = this.failFirstN;
  }
  async deployBootstrap(input: BootstrapInput): Promise<BootstrapResult> {
    // Demo/test: simulate a successful one-time setup without touching AWS or
    // ~/.aws. Mark the operator profile "configured" so the next identity probe
    // resolves, as if the deploy had really run.
    this.probes = this.failFirstN;
    const accountId = input.expectedAccountId ?? this.identity.accountId;
    return {
      accountId,
      brokerRoleArn: `arn:aws:iam::${accountId}:role/AgentsPoppyBroker`,
      operatorUserName: "AgentsPoppyOperator",
      operatorAccessKeyId: "AKIASTUBOPERATORKEY",
    };
  }
}
