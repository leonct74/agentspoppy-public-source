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
import { HOST_SESSION_PREFIX } from "@agentspoppy/core";
import {
  clearOperatorKeyRecord,
  operatorCredentials,
  readAgentsPoppyProfileKeyId,
  readOperatorKeyRecord,
  removeAgentsPoppyProfile,
  writeAgentsPoppyProfile,
  type AwsKeyInput,
} from "./credentials";
import { DEFAULT_OPERATOR_NAME, TEMPLATE_VERSION } from "./role-template";
import { maintenanceCredentials } from "./maintenance";
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

/** This machine's operator key, as far as the broker knows it — no secrets. */
export interface OperatorKeyInfo {
  /** The key id the `[agentspoppy]` profile holds right now (null: none stored). */
  profileKeyId: string | null;
  /** When THIS machine minted its operator key (null: unknown / pre-record install). */
  mintedAt: string | null;
}

/** The kill switch failed for a reason the UI must route, not just display. */
export class RevokeKeyError extends Error {
  constructor(
    message: string,
    readonly reason: "not-operator" | "no-key" | "setup-outdated",
  ) {
    super(message);
    this.name = "RevokeKeyError";
  }
}

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
   * else tells them to. Read-only. On template v4 the operator itself can no longer read
   * CloudFormation, so this read arrives through the broker role (maintenance session).
   */
  readSetupVersion(region?: string): Promise<SetupVersionStatus>;
  /**
   * The kill switch: delete THIS machine's operator access key, then remove it from disk —
   * in that order, and only that order (forgetting a key still live in AWS would invert the
   * audit finding this closes). Only meaningful when the standing identity IS the operator:
   * anything else throws `not-operator` so the UI routes to the key switch instead — on a
   * machine standing on a setup key, the recorded id may be the SETUP key's, and a
   * caller-inferred delete could destroy the very credential recovery depends on.
   */
  revokeOperatorKey?(region?: string): Promise<{ deletedKeyId: string; alreadyGone: boolean }>;
  /** This machine's key id + mint time (drives the key-age nudge). Never secrets. */
  operatorKeyInfo?(): Promise<OperatorKeyInfo>;
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
      // Read-only gateway routed through the maintenance session (falls back to the
      // raw operator chain until an account is configured) — on template v4 the
      // operator user itself holds no cloudformation:* anymore.
      return setupVersionStatus(await readSetupStack(sdkBootstrapGateway(r, undefined, maintenanceCredentials), r));
    },

    async operatorKeyInfo() {
      return {
        profileKeyId: readAgentsPoppyProfileKeyId(),
        mintedAt: readOperatorKeyRecord()?.mintedAt ?? null,
      };
    },

    async revokeOperatorKey(region) {
      const r = regionOrDefault(region);
      const { GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
      const sts = await stsClient(r);
      const out = await sts.send(new GetCallerIdentityCommand({}));
      const arn = out.Arn ?? "";
      if (!arn.includes(`:user/${DEFAULT_OPERATOR_NAME}`)) {
        throw new RevokeKeyError(
          `This machine is connected as ${arn || "an unknown identity"}, not the ${DEFAULT_OPERATOR_NAME} user — ` +
            `there is no operator key here to revoke. If this machine is standing on a powerful setup key, ` +
            `switch it to the operator key instead.`,
          "not-operator",
        );
      }
      const keyId = readAgentsPoppyProfileKeyId() ?? readOperatorKeyRecord()?.accessKeyId;
      if (!keyId) {
        throw new RevokeKeyError("No operator key is stored on this machine.", "no-key");
      }

      const { IAMClient, DeleteAccessKeyCommand } = await import("@aws-sdk/client-iam");
      const iam = new IAMClient({ region: r, credentials: await operatorCredentials() });
      let alreadyGone = false;
      try {
        // UserName explicit, never caller-inferred — see the interface note.
        await iam.send(new DeleteAccessKeyCommand({ UserName: DEFAULT_OPERATOR_NAME, AccessKeyId: keyId }));
      } catch (err) {
        const name = (err as { name?: string }).name ?? "";
        const msg = (err as Error).message ?? "";
        if (/NoSuchEntity/i.test(name)) {
          // The key is ALREADY dead (evicted by another machine's re-setup, or deleted
          // in the console). That is the outcome the button promises — clean up locally.
          alreadyGone = true;
        } else if (/not authorized|access.?denied/i.test(msg)) {
          throw new RevokeKeyError(
            `Your AgentsPoppy setup doesn't yet allow the key to revoke itself — that arrives with the ` +
              `current setup version. Re-apply setup first, then try again. Nothing was changed.`,
            "setup-outdated",
          );
        } else {
          throw err; // profile untouched — the key may still be live in AWS
        }
      }
      removeAgentsPoppyProfile();
      clearOperatorKeyRecord();
      return { deletedKeyId: keyId, alreadyGone };
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
            // HOST prefix, deliberately outside the poppy prefix `agentspoppy-`:
            // the old name "agentspoppy-verify" made the activity feed attribute
            // this probe to a poppy named "verify" (core/activity.ts).
            RoleSessionName: `${HOST_SESSION_PREFIX}verify`,
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
    return { ok: true, assumedArn: `${roleArn}/${HOST_SESSION_PREFIX}verify` };
  }
  async operatorKeyInfo(): Promise<OperatorKeyInfo> {
    return { profileKeyId: "AKIASTUBOPERATORKEY", mintedAt: new Date().toISOString() };
  }
  async revokeOperatorKey(): Promise<{ deletedKeyId: string; alreadyGone: boolean }> {
    // Demo/test: simulate the revoke without touching AWS or ~/.aws.
    this.probes = 0;
    return { deletedKeyId: "AKIASTUBOPERATORKEY", alreadyGone: false };
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
