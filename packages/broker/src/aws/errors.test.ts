// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import { isAwsAuthError } from "./errors";

const awsErr = (name: string, message = "", httpStatusCode?: number) =>
  Object.assign(new Error(message), { name, $metadata: httpStatusCode ? { httpStatusCode } : undefined });

describe("isAwsAuthError", () => {
  it("flags invalid/expired credential errors by name", () => {
    expect(isAwsAuthError(awsErr("InvalidClientTokenId", "The security token included in the request is invalid"))).toBe(true);
    expect(isAwsAuthError(awsErr("UnrecognizedClientException"))).toBe(true);
    expect(isAwsAuthError(awsErr("ExpiredToken"))).toBe(true);
  });

  it("flags permission denials (by name and by 403)", () => {
    expect(isAwsAuthError(awsErr("AccessDeniedException", "not authorized to perform: tag:GetResources"))).toBe(true);
    expect(isAwsAuthError(awsErr("SomethingElse", "boom", 403))).toBe(true);
  });

  it("flags credential-resolution failures by message", () => {
    expect(isAwsAuthError(awsErr("CredentialsProviderError", "Could not resolve credentials using profile: [agentspoppy]"))).toBe(true);
  });

  it("does NOT flag region/network/throttle errors", () => {
    expect(isAwsAuthError(awsErr("EndpointConnectionError", "Could not connect to the endpoint URL"))).toBe(false);
    expect(isAwsAuthError(awsErr("ThrottlingException", "Rate exceeded"))).toBe(false);
    expect(isAwsAuthError(awsErr("OptInRequired", "region not enabled"))).toBe(false);
    expect(isAwsAuthError(null)).toBe(false);
    expect(isAwsAuthError("nope")).toBe(false);
  });
});
