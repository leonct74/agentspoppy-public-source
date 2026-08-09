// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Presentation helpers for the per-app cloud-footprint view. Pure (no network):
 * turn an "AWS::X::Y" CloudFormation type into a friendly service name and a
 * region-aware AWS console deep-link so the user can verify each resource
 * first-hand, and group a stack's resources by service.
 *
 * Generalised from MailPoppy's resource-transparency view — fully app-agnostic.
 */
import type { ResourceEntry, LedgerEntry } from "./types";

const SERVICE_NAMES: Record<string, string> = {
  S3: "S3",
  Lambda: "Lambda",
  DynamoDB: "DynamoDB",
  Cognito: "Cognito",
  ApiGatewayV2: "API Gateway",
  ApiGateway: "API Gateway",
  SNS: "SNS",
  SQS: "SQS",
  Events: "EventBridge",
  IAM: "IAM",
  SES: "SES",
  Route53: "Route 53",
  CloudFormation: "CloudFormation",
  Logs: "CloudWatch Logs",
  EC2: "EC2",
  RDS: "RDS",
  StepFunctions: "Step Functions",
  CloudFront: "CloudFront",
  SecretsManager: "Secrets Manager",
  KMS: "KMS",
};

/** "AWS::Lambda::Function" → "Lambda" (friendly). Unknown namespaces pass through. */
export function serviceFor(cfnType: string): string {
  const parts = cfnType.split("::");
  const ns = parts[1] ?? cfnType;
  return SERVICE_NAMES[ns] ?? ns;
}

/**
 * Best-effort AWS console deep-link for a resource so the user can inspect it.
 * Returns undefined for types we don't have a specific URL for (the UI then
 * falls back to the CloudFormation stack view).
 */
export function awsConsoleUrl(type: string, physicalId: string, region: string): string | undefined {
  const id = physicalId;
  if (!id) return undefined;
  switch (type) {
    case "AWS::S3::Bucket":
      return `https://s3.console.aws.amazon.com/s3/buckets/${id}?region=${region}`;
    case "AWS::Lambda::Function":
      return `https://${region}.console.aws.amazon.com/lambda/home?region=${region}#/functions/${id}`;
    case "AWS::DynamoDB::Table":
      return `https://${region}.console.aws.amazon.com/dynamodbv2/home?region=${region}#table?name=${id}`;
    case "AWS::Cognito::UserPool":
      return `https://${region}.console.aws.amazon.com/cognito/v2/idp/user-pools/${id}/users?region=${region}`;
    case "AWS::ApiGatewayV2::Api":
      return `https://${region}.console.aws.amazon.com/apigateway/main/api-detail?api=${id}&region=${region}`;
    case "AWS::SNS::Topic":
      return `https://${region}.console.aws.amazon.com/sns/v3/home?region=${region}#/topic/${encodeURIComponent(id)}`;
    case "AWS::SQS::Queue":
      return `https://${region}.console.aws.amazon.com/sqs/v3/home?region=${region}#/queues`;
    case "AWS::IAM::Role":
      return `https://console.aws.amazon.com/iam/home#/roles/${id}`;
    case "AWS::Events::Rule":
      return `https://${region}.console.aws.amazon.com/events/home?region=${region}#/eventbus/default/rules/${id}`;
    case "AWS::SES::ReceiptRuleSet":
    case "AWS::SES::ReceiptRule":
      return `https://${region}.console.aws.amazon.com/ses/home?region=${region}#/email-receiving`;
    default:
      return undefined;
  }
}

/** Console link for a ledger (out-of-stack) entry, by service. */
export function ledgerConsoleUrl(entry: LedgerEntry): string | undefined {
  switch (entry.service) {
    case "Route 53":
    case "Route53":
      return `https://console.aws.amazon.com/route53/v2/hostedzones`;
    case "SES":
      return `https://${entry.region}.console.aws.amazon.com/ses/home?region=${entry.region}#/verified-identities`;
    case "S3":
      return `https://s3.console.aws.amazon.com/s3/buckets/${entry.name}?region=${entry.region}`;
    default:
      return undefined;
  }
}

/** Group resources by friendly service name, preserving input order within a group. */
export function groupByService(resources: ResourceEntry[]): Array<{ service: string; items: ResourceEntry[] }> {
  const map = new Map<string, ResourceEntry[]>();
  for (const r of resources) {
    const svc = serviceFor(r.type);
    const arr = map.get(svc) ?? [];
    arr.push(r);
    map.set(svc, arr);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([service, items]) => ({ service, items }));
}
