// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import { consoleUrlForArn } from "./console-url";

describe("consoleUrlForArn", () => {
  it("deep-links the common services a poppy creates", () => {
    expect(consoleUrlForArn("arn:aws:s3:::mailpoppy-mail", "eu-west-1")).toContain("s3/buckets/mailpoppy-mail");
    expect(consoleUrlForArn("arn:aws:cognito-idp:eu-west-1:1:userpool/eu-west-1_abc", "eu-west-1")).toContain("user-pools/eu-west-1_abc");
    expect(consoleUrlForArn("arn:aws:dynamodb:eu-west-1:1:table/MyTable", "eu-west-1")).toContain("name=MyTable");
    expect(consoleUrlForArn("arn:aws:lambda:eu-west-1:1:function:Fn", "eu-west-1")).toContain("functions/Fn");
  });

  it("uses the passed region for global-service ARNs (blank ARN region)", () => {
    const url = consoleUrlForArn("arn:aws:s3:::b", "ap-southeast-2");
    expect(url).toContain("region=ap-southeast-2");
  });

  it("points IAM roles at the role and route53 at hosted zones", () => {
    expect(consoleUrlForArn("arn:aws:iam::1:role/MailpoppyMailStack-Fn", "")).toContain("iam/home#/roles/MailpoppyMailStack-Fn");
    expect(consoleUrlForArn("arn:aws:route53:::hostedzone/Z1", "")).toContain("route53");
  });

  it("falls back to the service home for unmapped services, and is undefined for non-ARNs", () => {
    expect(consoleUrlForArn("arn:aws:kinesis:eu-west-1:1:stream/s", "eu-west-1")).toContain("kinesis/home");
    expect(consoleUrlForArn("not-an-arn", "eu-west-1")).toBeUndefined();
  });
});
