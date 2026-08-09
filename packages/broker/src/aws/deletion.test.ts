// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import type { ResidualResource } from "@agentspoppy/core";
import { deleteResiduals, type DeletionGateway } from "./deletion";

const APP = "com.example.poppy";
const R = "eu-west-1";

const residual = (arn: string, resourceType: string): ResidualResource => ({ arn, resourceType, region: R });

/** Recording fake: every deleter logs its call; tags and failures are configurable per ARN. */
class FakeDeletion implements DeletionGateway {
  calls: string[] = [];
  /** arn → tags returned by getTags (defaults to the app tag, i.e. verification passes). */
  tags = new Map<string, Record<string, string>>();
  /** id → error thrown by its deleter. */
  failures = new Map<string, Error>();

  async getTags(_region: string, arn: string): Promise<Record<string, string>> {
    return this.tags.get(arn) ?? { "agentspoppy:app": APP };
  }
  private run(op: string, id: string): Promise<void> {
    this.calls.push(`${op}:${id}`);
    const err = this.failures.get(id);
    return err ? Promise.reject(err) : Promise.resolve();
  }
  deleteBucket(_r: string, bucket: string) {
    return this.run("bucket", bucket);
  }
  deleteTable(_r: string, table: string) {
    return this.run("table", table);
  }
  deleteUserPool(_r: string, poolId: string) {
    return this.run("pool", poolId);
  }
  deleteFunction(_r: string, fn: string) {
    return this.run("function", fn);
  }
  deleteLogGroup(_r: string, name: string) {
    return this.run("log-group", name);
  }
  deleteSesIdentity(_r: string, identity: string) {
    return this.run("ses-identity", identity);
  }
  deleteReceiptRuleSet(_r: string, name: string) {
    return this.run("rule-set", name);
  }
}

function awsError(name: string, status?: number): Error {
  const err = new Error(name) as Error & { name: string; $metadata?: { httpStatusCode: number } };
  err.name = name;
  if (status) err.$metadata = { httpStatusCode: status };
  return err;
}

describe("deleteResiduals — type dispatch", () => {
  it("routes every supported resource type to its deleter with the right id", async () => {
    const gw = new FakeDeletion();
    const report = await deleteResiduals(
      [
        residual("arn:aws:s3:::mail-bucket-abc", "s3"),
        residual(`arn:aws:dynamodb:${R}:123:table/IndexTable`, "dynamodb:table"),
        residual(`arn:aws:cognito-idp:${R}:123:userpool/eu-west-1_AbC`, "cognito-idp:userpool"),
        residual(`arn:aws:lambda:${R}:123:function:inbound-fn`, "lambda:function"),
        residual(`arn:aws:logs:${R}:123:log-group:/aws/lambda/inbound-fn`, "logs:log-group"),
        residual(`arn:aws:ses:${R}:123:identity/example.com`, "ses:identity"),
        residual(`arn:aws:ses:${R}:123:receipt-rule-set/MailRuleSet`, "ses:receipt-rule-set"),
      ],
      APP,
      gw,
    );
    expect(gw.calls).toEqual([
      "bucket:mail-bucket-abc",
      "table:IndexTable",
      "pool:eu-west-1_AbC",
      "function:inbound-fn",
      // Log-group names contain "/" — the whole tail after "log-group:" must survive.
      "log-group:/aws/lambda/inbound-fn",
      "ses-identity:example.com",
      "rule-set:MailRuleSet",
    ]);
    expect(report.removed).toHaveLength(7);
    expect(report.failed).toEqual([]);
    expect(report.unsupported).toEqual([]);
  });

  it("reports types it has no deleter for as unsupported — never silently dropped", async () => {
    const gw = new FakeDeletion();
    const odd = residual(`arn:aws:kinesis:${R}:123:stream/events`, "kinesis:stream");
    const report = await deleteResiduals([odd], APP, gw);
    expect(report.unsupported).toEqual([odd]);
    expect(report.removed).toEqual([]);
    expect(gw.calls).toEqual([]); // nothing touched
  });
});

describe("deleteResiduals — the tag double-check", () => {
  it("refuses to delete when the live tag no longer attributes the resource to the app", async () => {
    const gw = new FakeDeletion();
    const arn = "arn:aws:s3:::somebody-elses-bucket";
    gw.tags.set(arn, { "agentspoppy:app": "com.other.poppy" }); // sweep index was stale
    const report = await deleteResiduals([residual(arn, "s3")], APP, gw);
    expect(gw.calls).toEqual([]); // the deleter was never invoked
    expect(report.removed).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].error).toMatch(/live tag check/);
    expect(report.failed[0].authError).toBe(false);
  });

  it("refuses when the resource has no tags at all any more", async () => {
    const gw = new FakeDeletion();
    const arn = "arn:aws:s3:::since-untagged";
    gw.tags.set(arn, {});
    const report = await deleteResiduals([residual(arn, "s3")], APP, gw);
    expect(gw.calls).toEqual([]);
    expect(report.failed).toHaveLength(1);
  });
});

describe("deleteResiduals — failure handling", () => {
  it("counts NotFound as removed (the tag index lags behind reality)", async () => {
    const gw = new FakeDeletion();
    gw.failures.set("gone-bucket", awsError("NoSuchBucket", 404));
    const report = await deleteResiduals([residual("arn:aws:s3:::gone-bucket", "s3")], APP, gw);
    expect(report.removed).toHaveLength(1);
    expect(report.failed).toEqual([]);
  });

  it("flags a permissions failure as authError so the UI can point at the access policy", async () => {
    const gw = new FakeDeletion();
    gw.failures.set("forbidden-bucket", awsError("AccessDenied", 403));
    const report = await deleteResiduals([residual("arn:aws:s3:::forbidden-bucket", "s3")], APP, gw);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].authError).toBe(true);
  });

  it("one failure never aborts the rest — later residuals still get deleted", async () => {
    const gw = new FakeDeletion();
    gw.failures.set("bad-table", new Error("boom"));
    const report = await deleteResiduals(
      [
        residual(`arn:aws:dynamodb:${R}:123:table/bad-table`, "dynamodb:table"),
        residual(`arn:aws:dynamodb:${R}:123:table/good-table`, "dynamodb:table"),
      ],
      APP,
      gw,
    );
    expect(gw.calls).toEqual(["table:bad-table", "table:good-table"]);
    expect(report.removed.map((r) => r.arn)).toEqual([`arn:aws:dynamodb:${R}:123:table/good-table`]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].error).toBe("boom");
    expect(report.failed[0].authError).toBe(false);
  });
});
