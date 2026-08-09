// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import type { ConnectedAccount, Connection, ResourceEntry } from "@agentspoppy/core";
import { CloudFormationProvider, type CfnGateway, type CfnStackSummary } from "./cloudformation";
import type { TaggingGateway, TaggedResource } from "./tagging";

/** In-memory tagging API, region → ARNs. Asserts the query targets the app tag. */
class FakeTagging implements TaggingGateway {
  queried: Array<{ region: string; key: string; value: string }> = [];
  constructor(private readonly arns: Record<string, string[]>) {}
  async getResourcesByTag(region: string, key: string, value: string): Promise<TaggedResource[]> {
    this.queried.push({ region, key, value });
    return (this.arns[region] ?? []).map((arn) => ({ arn }));
  }
}

const account: ConnectedAccount = {
  id: "acc-1",
  accountId: "123456789012",
  regions: ["eu-west-1", "us-east-1"],
  createdAt: "2026-01-01T00:00:00.000Z",
};

const connection: Connection = {
  id: "conn-abc",
  accountId: account.id,
  app: { id: "com.mailpoppy.desktop", name: "MailPoppy" },
  status: "active",
  permissionSet: { id: "ps", name: "PS", description: "", grants: [], requiredTags: [], limits: null },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** In-memory CloudFormation, region → stacks. Records deletions + emptied buckets. */
class FakeGateway implements CfnGateway {
  deleted: Array<{ region: string; stackName: string }> = [];
  emptied: string[] = [];
  /** Order log: proves buckets are emptied BEFORE the stack delete fires. */
  calls: string[] = [];
  constructor(private readonly stacks: Record<string, CfnStackSummary[]>) {}

  async listStacks(region: string): Promise<CfnStackSummary[]> {
    return this.stacks[region] ?? [];
  }
  async listResources(_region: string, stackName: string): Promise<ResourceEntry[]> {
    return [{ logicalId: "Bucket", physicalId: `${stackName}-bkt`, type: "AWS::S3::Bucket", status: "CREATE_COMPLETE" }];
  }
  async getTemplate(_region: string, _stackName: string): Promise<string | undefined> {
    return undefined;
  }
  deactivated: string[][] = [];
  async emptyBucket(_region: string, bucket: string): Promise<void> {
    this.emptied.push(bucket);
    this.calls.push(`empty:${bucket}`);
  }
  async deactivateReceiptRuleSets(_region: string, ruleSetNames: string[]): Promise<void> {
    this.deactivated.push(ruleSetNames);
    this.calls.push(`deactivate:${ruleSetNames.join(",")}`);
  }
  async deleteStack(region: string, stackName: string): Promise<void> {
    this.deleted.push({ region, stackName });
    this.calls.push(`delete:${stackName}`);
  }
  async waitForDelete(_region: string, _stackName: string): Promise<string> {
    return "DELETE_COMPLETE";
  }
  async describeDeleteFailure(_region: string, _stackName: string): Promise<string> {
    return "";
  }
}

// Ownership is by the stable app tag, NOT the connection id. `ours` carries this
// connection's app id; `otherApp` belongs to a different app on the same account.
const ours = { "agentspoppy:app": connection.app.id };
const otherApp = { "agentspoppy:app": "com.someone.else" };

describe("CloudFormationProvider.listStacks", () => {
  it("returns only stacks tagged for this app, across all account regions", async () => {
    const gw = new FakeGateway({
      "eu-west-1": [
        { stackName: "ours-eu", region: "eu-west-1", tags: ours },
        { stackName: "someone-else", region: "eu-west-1", tags: otherApp },
      ],
      "us-east-1": [{ stackName: "ours-us", region: "us-east-1", tags: ours }],
    });
    const provider = new CloudFormationProvider(gw);

    const stacks = await provider.listStacks(connection, account);
    expect(stacks.map((s) => s.stackName).sort()).toEqual(["ours-eu", "ours-us"]);
    expect(stacks[0]?.resources).toHaveLength(1);
    expect(stacks.every((s) => s.stackExists)).toBe(true);
  });

  it("reclaims a stack created by a SUPERSEDED connection of the same app", async () => {
    // The stack was created by an older connection (since revoked + replaced); it
    // still carries the app tag plus a stale connection audit tag. Ownership keys on
    // the app, so the current connection finds it instead of orphaning it.
    const gw = new FakeGateway({
      "eu-west-1": [
        {
          stackName: "MailpoppyMailStack",
          region: "eu-west-1",
          tags: { "agentspoppy:app": connection.app.id, "agentspoppy:connection": "old-revoked-conn" },
        },
      ],
    });
    const stacks = await new CloudFormationProvider(gw).listStacks(connection, account);
    expect(stacks.map((s) => s.stackName)).toEqual(["MailpoppyMailStack"]);
  });
});

describe("CloudFormationProvider.findResiduals (the leaves-no-trace sweep)", () => {
  it("returns every tagged resource across regions, with a derived type, querying the app tag", async () => {
    const tagging = new FakeTagging({
      "eu-west-1": ["arn:aws:s3:::mailpoppy-mail-7f3a", "arn:aws:lambda:eu-west-1:123:function:inbound"],
      "us-east-1": ["arn:aws:dynamodb:us-east-1:123:table/MailTable"],
    });
    const provider = new CloudFormationProvider(new FakeGateway({}), tagging);
    const residuals = await provider.findResiduals(connection, account);

    expect(residuals.map((r) => r.resourceType).sort()).toEqual(["dynamodb:table", "lambda:function", "s3"]);
    expect(residuals.find((r) => r.arn.includes("dynamodb"))?.region).toBe("us-east-1");
    // It must filter by THIS app's attribution tag, not blindly list everything.
    expect(tagging.queried.every((q) => q.key === "agentspoppy:app" && q.value === connection.app.id)).toBe(true);
  });

  it("is empty (clean) when the account has no tagged resources", async () => {
    const provider = new CloudFormationProvider(new FakeGateway({}), new FakeTagging({}));
    expect(await provider.findResiduals(connection, account)).toEqual([]);
  });
});

describe("CloudFormationProvider region coverage", () => {
  // The account is recorded with only us-east-1, but the extension deployed to
  // eu-west-1 (its own region picker). Teardown/inventory must still find it.
  const usOnly: ConnectedAccount = { ...account, regions: ["us-east-1"] };

  it("finds a connection's stack in a region NOT listed on the account", async () => {
    const gw = new FakeGateway({
      "eu-west-1": [{ stackName: "MailpoppyMailStack", region: "eu-west-1", tags: ours }],
    });
    const stacks = await new CloudFormationProvider(gw).listStacks(connection, usOnly);
    expect(stacks.map((s) => s.stackName)).toEqual(["MailpoppyMailStack"]);
    expect(stacks[0]?.region).toBe("eu-west-1");
  });

  it("deletes a stack in a region NOT listed on the account", async () => {
    const gw = new FakeGateway({
      "eu-west-1": [{ stackName: "MailpoppyMailStack", region: "eu-west-1", tags: ours }],
    });
    await new CloudFormationProvider(gw).deleteStack(connection, usOnly, "MailpoppyMailStack");
    expect(gw.deleted).toEqual([{ region: "eu-west-1", stackName: "MailpoppyMailStack" }]);
  });

  it("skips regions whose listStacks errors (opt-in not enabled) instead of failing", async () => {
    class FlakyGateway extends FakeGateway {
      override async listStacks(region: string) {
        if (region === "ap-northeast-3") throw new Error("region not enabled");
        return super.listStacks(region);
      }
    }
    const gw = new FlakyGateway({
      "eu-west-1": [{ stackName: "MailpoppyMailStack", region: "eu-west-1", tags: ours }],
    });
    const stacks = await new CloudFormationProvider(gw).listStacks(connection, usOnly);
    expect(stacks.map((s) => s.stackName)).toEqual(["MailpoppyMailStack"]);
  });
});

describe("CloudFormationProvider.deleteStack", () => {
  it("deletes a stack that belongs to the app", async () => {
    const gw = new FakeGateway({
      "eu-west-1": [{ stackName: "ours-eu", region: "eu-west-1", tags: ours }],
      "us-east-1": [],
    });
    await new CloudFormationProvider(gw).deleteStack(connection, account, "ours-eu");
    expect(gw.deleted).toEqual([{ region: "eu-west-1", stackName: "ours-eu" }]);
  });

  it("refuses to delete a stack that belongs to a different app", async () => {
    const gw = new FakeGateway({
      "eu-west-1": [{ stackName: "not-ours", region: "eu-west-1", tags: otherApp }],
      "us-east-1": [],
    });
    await expect(new CloudFormationProvider(gw).deleteStack(connection, account, "not-ours")).rejects.toThrow(
      /not attributed/,
    );
    expect(gw.deleted).toEqual([]);
  });

  it("throws when the stack is not found in any region", async () => {
    const gw = new FakeGateway({ "eu-west-1": [], "us-east-1": [] });
    await expect(new CloudFormationProvider(gw).deleteStack(connection, account, "ghost")).rejects.toThrow(/not found/);
  });

  it("empties the stack's S3 buckets BEFORE deleting (so a non-empty bucket can't stall it)", async () => {
    const gw = new FakeGateway({ "eu-west-1": [{ stackName: "ours-eu", region: "eu-west-1", tags: ours }] });
    await new CloudFormationProvider(gw).deleteStack(connection, account, "ours-eu");
    expect(gw.emptied).toEqual(["ours-eu-bkt"]);
    expect(gw.calls).toEqual(["empty:ours-eu-bkt", "delete:ours-eu"]); // order matters
  });

  it("deactivates an active SES receipt rule set before deleting (can't delete an active set)", async () => {
    class SesGateway extends FakeGateway {
      override async listResources(): Promise<ResourceEntry[]> {
        return [
          { logicalId: "RuleSet", physicalId: "MailpoppyMailRuleSet", type: "AWS::SES::ReceiptRuleSet", status: "CREATE_COMPLETE" },
        ];
      }
    }
    const gw = new SesGateway({ "eu-west-1": [{ stackName: "ours-eu", region: "eu-west-1", tags: ours }] });
    await new CloudFormationProvider(gw).deleteStack(connection, account, "ours-eu");
    expect(gw.deactivated).toEqual([["MailpoppyMailRuleSet"]]);
    expect(gw.calls).toEqual(["deactivate:MailpoppyMailRuleSet", "delete:ours-eu"]); // before delete
  });

  it("throws when the stack does not reach DELETE_COMPLETE", async () => {
    class StuckGateway extends FakeGateway {
      override async waitForDelete(): Promise<string> {
        return "DELETE_FAILED";
      }
    }
    const gw = new StuckGateway({ "eu-west-1": [{ stackName: "ours-eu", region: "eu-west-1", tags: ours }] });
    await expect(new CloudFormationProvider(gw).deleteStack(connection, account, "ours-eu")).rejects.toThrow(
      /did not delete cleanly.*DELETE_FAILED/,
    );
  });
});
