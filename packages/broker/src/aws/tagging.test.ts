// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import { resourceTypeFromArn } from "./tagging";

describe("resourceTypeFromArn", () => {
  it("derives service:type from a typed ARN", () => {
    expect(resourceTypeFromArn("arn:aws:lambda:eu-west-1:123456789012:function:Fn")).toBe("lambda:function");
    expect(resourceTypeFromArn("arn:aws:cognito-idp:eu-west-1:123456789012:userpool/eu-west-1_AbC")).toBe(
      "cognito-idp:userpool",
    );
    expect(resourceTypeFromArn("arn:aws:dynamodb:eu-west-1:123456789012:table/MailTable")).toBe("dynamodb:table");
  });

  it("falls back to the service when there is no distinct type segment", () => {
    expect(resourceTypeFromArn("arn:aws:s3:::my-bucket")).toBe("s3");
  });

  it("does not throw on a malformed ARN", () => {
    expect(resourceTypeFromArn("not-an-arn")).toBe("");
  });
});
