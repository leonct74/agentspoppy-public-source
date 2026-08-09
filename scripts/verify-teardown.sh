#!/usr/bin/env bash
# Copyright 2026 Marco Tomasello (AgentsPoppy)
# SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0
#
# Ground-truth check for the teardown test plan (docs/TEARDOWN_TEST_PLAN.md).
#
# READ-ONLY. It never deletes anything. It answers one question that the app's own
# report can also lie about if the tag index lags: "does AWS itself still hold any
# resource tagged as built by <poppy>?" — the definition of a clean teardown.
#
# Usage:
#   scripts/verify-teardown.sh <app-id> [region ...]
#   scripts/verify-teardown.sh com.mailpoppy.desktop eu-west-1 us-east-1
#
# Exit 0 = clean (no tagged resources found). Exit 2 = leftovers found.
# Requires: awscli v2, jq, and credentials for the SAME account the poppy is in
# (the app cross-checks this; so should you — see NOTE below).

set -euo pipefail

APP_ID="${1:?usage: verify-teardown.sh <app-id> [region ...]}"
shift || true
REGIONS=("$@")
if [ ${#REGIONS[@]} -eq 0 ]; then
  # The 18 standard commercial regions the broker's own sweep covers (regions.ts).
  REGIONS=(us-east-1 us-east-2 us-west-1 us-west-2 ca-central-1 \
           eu-west-1 eu-west-2 eu-west-3 eu-central-1 eu-north-1 eu-south-1 \
           ap-south-1 ap-southeast-1 ap-southeast-2 ap-northeast-1 ap-northeast-2 ap-northeast-3 \
           sa-east-1)
fi

TAG_KEY="agentspoppy:app"

echo "== AgentsPoppy teardown verification =="
WHO=$(aws sts get-caller-identity --query Account --output text)
echo "Credentials belong to account: ${WHO}"
echo "Looking for anything tagged ${TAG_KEY}=${APP_ID}"
echo "Regions: ${REGIONS[*]}"
echo

FOUND=0
for region in "${REGIONS[@]}"; do
  # Resource Groups Tagging API — the exact index the broker sweep queries.
  arns=$(aws resourcegroupstaggingapi get-resources \
           --region "$region" \
           --tag-filters "Key=${TAG_KEY},Values=${APP_ID}" \
           --query 'ResourceTagMappingList[].ResourceARN' \
           --output text 2>/dev/null || true)
  if [ -n "$arns" ]; then
    for arn in $arns; do
      echo "  LEFTOVER [$region] $arn"
      FOUND=$((FOUND + 1))
    done
  fi
done

echo
if [ "$FOUND" -eq 0 ]; then
  echo "✅ CLEAN — no resources tagged as built by ${APP_ID} remain in the scanned regions."
  echo "   (NOTE: the tagging index is eventually consistent; if you JUST tore down,"
  echo "    wait ~1 min and re-run to rule out a lagging index.)"
  exit 0
else
  echo "❌ ${FOUND} resource(s) still tagged as built by ${APP_ID} — teardown is NOT clean."
  echo "   Open each ARN in the console and confirm whether it truly exists (the index"
  echo "   can also over-report a just-deleted resource for a minute)."
  exit 2
fi
