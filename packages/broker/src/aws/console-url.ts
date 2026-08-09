// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Best-effort AWS-console deep links for a resource ARN, so the infra graph can offer a
 * "open in console" jump per node — the escape hatch that lets a user finish a cleanup by
 * hand if a teardown ever leaves something behind.
 *
 * Pure string-building (no AWS): we map the common services a poppy creates to their
 * console URL, and fall back to the service's console home (then the account console) when
 * a resource type isn't specially handled. Links are a convenience, never load-bearing.
 */

interface ParsedArn {
  service: string;
  region: string;
  /** The resource portion after the account id: "type/id", "type:id", or just "id". */
  resource: string;
  /** The bare resource id (last path/colon segment), e.g. a bucket name or user-pool id. */
  id: string;
}

function parseArn(arn: string): ParsedArn | null {
  const parts = arn.split(":");
  if (parts.length < 6 || parts[0] !== "arn") return null;
  const resource = parts.slice(5).join(":");
  const id = resource.split(/[/:]/).pop() ?? resource;
  return { service: parts[2] ?? "", region: parts[3] ?? "", resource, id };
}

const home = (region: string, path: string): string =>
  `https://${region}.console.aws.amazon.com/${path}?region=${region}`;

/**
 * A console URL for the given ARN. `region` is the region the resource was found in (it
 * overrides the ARN's region, which is blank for global services like S3 and IAM).
 */
export function consoleUrlForArn(arn: string, region: string): string | undefined {
  const p = parseArn(arn);
  if (!p) return undefined;
  const r = region || p.region || "us-east-1";

  switch (p.service) {
    case "s3":
      return `https://s3.console.aws.amazon.com/s3/buckets/${p.id}?region=${r}`;
    case "dynamodb":
      return `${home(r, "dynamodbv2/home")}#table?name=${p.id}`;
    case "lambda":
      return `${home(r, "lambda/home")}#/functions/${p.id}`;
    case "cognito-idp":
      return `${home(r, "cognito/v2/idp/user-pools/" + p.id + "/users")}`;
    case "cloudformation":
      return `${home(r, "cloudformation/home")}#/stacks`;
    case "ses":
    case "sesv2":
      return home(r, "ses/home");
    case "sqs":
      return home(r, "sqs/v3/home");
    case "sns":
      return home(r, "sns/v3/home");
    case "states":
      return home(r, "states/home");
    case "logs":
      return home(r, "cloudwatch/home");
    case "iam":
      return p.resource.startsWith("role/")
        ? `https://us-east-1.console.aws.amazon.com/iam/home#/roles/${p.id}`
        : "https://us-east-1.console.aws.amazon.com/iam/home#/home";
    case "route53":
      return "https://us-east-1.console.aws.amazon.com/route53/v2/hostedzones";
    case "apigateway":
    case "execute-api":
      return home(r, "apigateway/main/apis");
    default:
      return p.service ? home(r, `${p.service}/home`) : home(r, "console/home");
  }
}
