import { describe, it, expect } from "vitest";
import type { ConnectedAccount } from "@agentspoppy/core";
import { brokerRoleArnFor, DEFAULT_BROKER_ROLE_NAME } from "./brokerRole";

const acct = (over: Partial<ConnectedAccount>): ConnectedAccount => ({
  id: "x",
  accountId: "1",
  regions: [],
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

describe("brokerRoleArnFor", () => {
  it("derives the default account-global broker-role ARN when nothing else is known", () => {
    expect(brokerRoleArnFor("123456789012", [])).toBe(
      `arn:aws:iam::123456789012:role/${DEFAULT_BROKER_ROLE_NAME}`,
    );
  });

  it("reuses a role name already proven on a sibling account", () => {
    const accounts = [acct({ id: "a", accountId: "999", roleArn: "arn:aws:iam::999:role/CustomBroker" })];
    expect(brokerRoleArnFor("123456789012", accounts)).toBe("arn:aws:iam::123456789012:role/CustomBroker");
  });

  it("ignores accounts that themselves have no roleArn", () => {
    expect(brokerRoleArnFor("1", [acct({ id: "a", accountId: "999" })])).toBe(
      `arn:aws:iam::1:role/${DEFAULT_BROKER_ROLE_NAME}`,
    );
  });
});
