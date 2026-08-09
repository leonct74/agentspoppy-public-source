// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import { readOnlyGrants, operationIsMutating, grantCoveredBy, grantsSubsetOf } from "./approvals";
import { TAGGED_AS_SELF } from "./types";
import type { PermissionGrant } from "./types";

const g = (service: string, actions: string[], resourceScope = "*"): PermissionGrant => ({ service, actions, resourceScope });

describe("readOnlyGrants", () => {
  it("keeps only non-mutating grants", () => {
    const grants = [g("s3", ["ListBucket"]), g("s3", ["DeleteObject"]), g("ses", ["GetAccount"])];
    expect(readOnlyGrants(grants)).toEqual([g("s3", ["ListBucket"]), g("ses", ["GetAccount"])]);
  });

  it("treats a wildcard action as mutating (so it is dropped from the read subset)", () => {
    expect(readOnlyGrants([g("iam", ["*"])])).toEqual([]);
  });
});

describe("operationIsMutating", () => {
  it("is true when any grant can change/destroy", () => {
    expect(operationIsMutating({ summary: "x", grants: [g("cognito-idp", ["DeleteUserPool"], TAGGED_AS_SELF)] })).toBe(true);
  });
  it("is false for a read-only operation", () => {
    expect(operationIsMutating({ summary: "x", grants: [g("cognito-idp", ["ListUsers"], TAGGED_AS_SELF)] })).toBe(false);
  });
});

describe("grantCoveredBy", () => {
  const conn = [
    g("cognito-idp", ["DeleteUserPool", "ListUsers"], TAGGED_AS_SELF),
    g("s3", ["s3:*"], "arn:aws:s3:::mailpoppy*"),
  ];

  it("covers an exact action + scope match", () => {
    expect(grantCoveredBy(g("cognito-idp", ["DeleteUserPool"], TAGGED_AS_SELF), conn)).toBe(true);
  });

  it("treats a service wildcard in the connection as covering any action of that service+scope", () => {
    expect(grantCoveredBy(g("s3", ["PutObject"], "arn:aws:s3:::mailpoppy*"), conn)).toBe(true);
  });

  it("normalises the optional service: prefix on action names", () => {
    expect(grantCoveredBy(g("cognito-idp", ["cognito-idp:ListUsers"], TAGGED_AS_SELF), conn)).toBe(true);
  });

  it("fails closed on a scope the connection does not grant (no ARN-pattern subsumption)", () => {
    // Asking for a different bucket pattern than the connection allows → not covered.
    expect(grantCoveredBy(g("s3", ["PutObject"], "arn:aws:s3:::someone-else*"), conn)).toBe(false);
  });

  it("rejects an action the connection never granted", () => {
    expect(grantCoveredBy(g("cognito-idp", ["DeleteUserPoolClient"], TAGGED_AS_SELF), conn)).toBe(false);
  });
});

describe("grantsSubsetOf", () => {
  const conn = [g("cognito-idp", ["DeleteUserPool", "ListUsers"], TAGGED_AS_SELF)];

  it("accepts an operation that asks for nothing beyond the connection", () => {
    expect(grantsSubsetOf([g("cognito-idp", ["DeleteUserPool"], TAGGED_AS_SELF)], conn)).toBe(true);
  });

  it("refuses an operation that tries to widen access", () => {
    // A broader scope ("*") than the connection's tag-scope must be refused (escalation).
    expect(grantsSubsetOf([g("cognito-idp", ["DeleteUserPool"], "*")], conn)).toBe(false);
    // An undeclared service must be refused.
    expect(grantsSubsetOf([g("dynamodb", ["DeleteTable"], "*")], conn)).toBe(false);
  });
});
