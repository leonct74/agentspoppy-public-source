import type { ConnectedAccount } from "@agentspoppy/core";

// AgentsPoppy's broker role (the role it assumes via STS to vend a poppy its scoped,
// short-lived credentials) has a fixed name, and IAM is account-global — so its ARN
// is fully derivable from the AWS account id. An account can reach a usable state
// WITHOUT this ARN recorded (linked manually, re-pointed by the region switcher, or
// bootstrapped on another region's row), which starves credential vending. Deriving
// it here lets the app re-assign + verify it. Mirrors the broker's DEFAULT_ROLE_NAME.
export const DEFAULT_BROKER_ROLE_NAME = "AgentsPoppyBroker";

/**
 * The broker-role ARN for an account — preferring a role name already proven on a
 * sibling account (in case a non-default name was used), else the product default.
 */
export function brokerRoleArnFor(accountId: string, accounts: ConnectedAccount[]): string {
  const sibling = accounts.map((a) => a.roleArn).find((arn): arn is string => !!arn);
  const roleName = sibling?.match(/:role\/(.+)$/)?.[1] ?? DEFAULT_BROKER_ROLE_NAME;
  return `arn:aws:iam::${accountId}:role/${roleName}`;
}
