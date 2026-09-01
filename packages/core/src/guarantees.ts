// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Panel 1 — what AgentsPoppy enforces (docs/specs/permission-presentation.md).
 *
 * The permission screen has only ever shown what could go WRONG. The guarantees that make a
 * poppy safe to install — temporary credentials, narrowing-only sessions, born-tagged creates,
 * a sweepable footprint — are real, tested, and appear nowhere, so at the exact moment a user
 * decides they see the dangers and none of the floor.
 *
 * THE TRAP THIS MODULE EXISTS TO AVOID. It is tempting to render this as a static reassuring
 * list. It is not static: three of these guarantees are conditional on the poppy in front of
 * you. Born-tagged-or-refused (I3) applies only where a grant is tag-scoped; the complete sweep
 * (I4) needs the attribution tags declared; and supervision is a per-connection switch the user
 * can turn off. Printing a conditional guarantee as universal is the same overstatement the rest
 * of this screen has been fixing, only in the reassuring direction — which is the worse one,
 * because nobody presses on a green line.
 *
 * So a guarantee that does not hold is returned with `holds: false` and the reason, and the UI
 * shows it as not applying rather than dropping it. A user comparing two poppies can then see
 * that one is tag-attributable and the other is not.
 */
import { hasAttributionTags, grantIsTagScoped } from "./permissions";
import type { PermissionSet } from "./types";

/**
 * The session lifetime and approval window, mirrored from the broker so this browser-safe
 * module needs no broker import. `packages/broker/src/guarantees-match-broker.test.ts` fails if
 * they ever drift — the same guard shape as rating-matches-compiler.test.ts, and for the same
 * reason: a number quoted to the user is a claim, and a stale claim is a false one.
 */
export const SESSION_MAX_SECONDS = 3600;
export const APPROVAL_WINDOW_MINUTES = 15;

export interface Guarantee {
  /** Stable key, for tests and for the UI to reason about without matching prose. */
  id: string;
  /** The promise, in the user's terms. */
  text: string;
  /** Where it is enforced — a guarantee nobody can check is just a claim. */
  pin: string;
  /** False when this particular poppy does not get it. */
  holds: boolean;
  /** Why not. Present only when `holds` is false. */
  absent?: string;
}

export interface GuaranteeContext {
  /** The connection's live supervision state — the user can turn it off. */
  supervised: boolean;
}

/**
 * What the platform enforces for THIS connection. Ordered so the unconditional floor comes
 * first: those are true of every poppy in the catalogue, whatever its manifest says.
 */
export function brokerGuarantees(ps: PermissionSet, ctx: GuaranteeContext): Guarantee[] {
  const anyTagScoped = ps.grants.some(grantIsTagScoped);
  const attributable = hasAttributionTags(ps);

  return [
    {
      id: "temporary-credentials",
      text: `It never holds your AWS keys. It gets a temporary session, minted for the job, that expires within ${SESSION_MAX_SECONDS / 3600} hour.`,
      pin: "broker aws/sts.ts — session duration is capped, not requested",
      holds: true,
    },
    {
      id: "narrowing-only",
      text: "That session can only ever be narrower than the role you installed. Nothing the broker issues can widen it.",
      pin: "invariant I1 — IAM session-policy intersection",
      holds: true,
    },
    {
      id: "no-identity-control",
      text: "It can never manage the people in your account — no IAM users, no passwords or access keys, no MFA changes, and no account or organisation settings.",
      pin: "broker role guardrails — an explicit Deny on the role itself",
      holds: true,
    },
    {
      id: "no-admin-escalation",
      text: "It can never hand itself administrator access by attaching AWS's admin policies to something it made.",
      pin: "broker role guardrails — AdministratorAccess, IAMFullAccess, PowerUserAccess denied",
      holds: true,
    },
    {
      id: "no-audit-tampering",
      text: "It can never switch off CloudTrail — the record of what it did in your account.",
      pin: "broker role guardrails — StopLogging, DeleteTrail and friends denied",
      holds: true,
    },
    {
      id: "ownership-outlives-connection",
      text: "What it made stays findable even if this connection is replaced, so removing it later still finds everything.",
      pin: "invariant I5 — ownership pinned to the app, not the connection",
      holds: true,
    },
    {
      id: "audit-trail",
      text: "Every change to this connection is written to a trail you can read.",
      pin: "broker service.ts — getAudit",
      holds: true,
    },
    {
      id: "kill-switch",
      text: "You can revoke this machine's operator key at any moment and cut every poppy off at once.",
      pin: "broker service.ts — revokeOperatorKey",
      holds: true,
    },
    // --- conditional on this poppy, and said so ---
    {
      id: "born-tagged",
      text: "Anything it creates is born carrying its own tag, or AWS refuses to create it.",
      pin: "invariant I3 — an aws:RequestTag condition on every create",
      holds: anyTagScoped,
      ...(anyTagScoped
        ? {}
        : {
            absent:
              "This poppy confines itself by naming its resources rather than tagging them. That still stops it reaching anything else, but nothing enforces that it created what sits under those names.",
          }),
    },
    {
      id: "sweepable",
      text: "Its whole footprint is findable in one query, which is what “remove everything” sweeps.",
      pin: "invariant I4 — certified against a real deploy and teardown",
      holds: attributable,
      ...(attributable
        ? {}
        : { absent: "This poppy has not declared the attribution tags, so removing it cannot rely on a single sweep." }),
    },
    {
      id: "supervised",
      text: `Every change waits for your approval, and an approval you do not answer expires after ${APPROVAL_WINDOW_MINUTES} minutes. Reads are not gated.`,
      pin: "broker service.ts — on by default for access outside the poppy's own resources",
      holds: ctx.supervised,
      ...(ctx.supervised ? {} : { absent: "Supervision is switched off for this connection. You can turn it back on above." }),
    },
  ];
}
