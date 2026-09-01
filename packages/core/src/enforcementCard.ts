// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The BASIC view's enforcement card (founder, 2026-09-01): what the platform enforces,
 * readable by everyone — the advanced panels stay for people who assess poppies in
 * depth.
 *
 * Modelled on the privacy "nutrition label" standard (Apple's App Store privacy cards,
 * Google Play's Data Safety, the FCC Cyber Trust Mark): a FIXED set of rows, in a FIXED
 * order, on every poppy — a user learns the card once and can compare any two poppies at
 * a glance. Rows are never omitted; a fact that does not hold is shown in its slot with
 * its honest state, because comparability is the whole point.
 *
 * Every row derives from the same engines the advanced panels use (permissions.ts,
 * network.ts, guarantees.ts constants) — the card is a compression, never a second
 * opinion. Wording rules apply in full: enforced facts may say "enforced"; declarations
 * say "declares"; nothing gets a stronger word than its mechanism (rule 6, and the
 * false-green lesson of guarantees.ts).
 */
import { grantCanMutate, grantIsTagScoped, hasAttributionTags, scopeIsUnbounded } from "./permissions";
import { canDeployCloudCompute, declaredEgressTitle, declaredMachineTitle, infrastructureTitle } from "./network";
import { APPROVAL_WINDOW_MINUTES, SESSION_MAX_SECONDS } from "./guarantees";
import type { PermissionSet } from "./types";

/** How strongly the row's fact holds — drives the chip and the colour, never the prose. */
export type CardState = "enforced" | "partial" | "declared" | "undeclared" | "off";

export interface CardRow {
  /** Stable key; also picks the icon. */
  id: "keys" | "reach" | "egress" | "approval" | "exit" | "record" | "limits";
  /** Two-or-three-word label, identical on every poppy. */
  label: string;
  state: CardState;
  /** The chip text — one word where possible. */
  stateWord: string;
  /** One plain sentence — up to four on the egress row, which has three doors to state. */
  sentence: string;
}

/**
 * The card, fixed order: keys · reach · egress · approval · exit · record · limits.
 * The two facts a typical user fears most — what it can touch, where data can leave —
 * sit second and third, right under the keys.
 */
export function enforcementCard(
  ps: PermissionSet,
  ctx: {
    supervised: boolean;
    /** True ONLY when the running host reports the machine gate armed for this
     *  connection (registry machineGate === "enforced") — a manifest alone must
     *  never graduate a declaration to "Host-enforced". */
    machineGateArmed?: boolean;
  },
): CardRow[] {
  const wide = ps.grants.filter((g) => !grantIsTagScoped(g) && scopeIsUnbounded(g.resourceScope, g.service));
  const mutating = ps.grants.filter(grantCanMutate);
  const labellingEnforced = hasAttributionTags(ps) && mutating.length > 0 && mutating.every(grantIsTagScoped);

  const rows: CardRow[] = [];

  rows.push({
    id: "keys",
    label: "Your keys",
    state: "enforced",
    stateWord: "Enforced",
    sentence: `Never holds your AWS keys — it works on temporary sessions that expire within ${SESSION_MAX_SECONDS / 3600} hour and can only ever be narrower than what you installed.`,
  });

  rows.push(
    wide.length === 0
      ? {
          id: "reach",
          label: "Your cloud",
          state: "enforced",
          stateWord: "Confined",
          sentence: "Everything it touches is confined to its own resources — AWS refuses anything else, on every request.",
        }
      : {
          id: "reach",
          label: "Your cloud",
          state: "partial",
          stateWord: `${ps.grants.length - wide.length} of ${ps.grants.length} confined`,
          sentence: `${ps.grants.length - wide.length} of its ${ps.grants.length} permissions are confined to its own resources; ${wide.length} reach beyond them — the advanced view lists each one.`,
        },
  );

  const net = ps.network;
  if (net) {
    const infra = infrastructureTitle(net.infrastructure);
    // The chip may graduate ONLY on door 3 (`network.machine`) — the plane the host
    // actually gates. A declaration about the poppy's CLOUD code is a promise about
    // Lambdas the host never sees, so it can never earn "Host-enforced", and the
    // machine sentence says "from your machine" so the tick can't be read onto it.
    // "user-directed" has no list a gate could refuse against — log-only by nature, so
    // it may NEVER wear Host-enforced, whatever any flag says (defense in depth: the
    // registry also reports it as "observed").
    const machine = net.machine;
    const armed = ctx.machineGateArmed === true && machine !== undefined && machine !== "user-directed";
    rows.push({
      id: "egress",
      label: "Data exits",
      state: armed ? "enforced" : "declared",
      // Wording law (machine-gate.md): "the host refuses", never "cannot connect" —
      // and the graduated chip appears only on the live host's say-so.
      stateWord: armed ? "Host-enforced" : "Declared",
      sentence:
        declaredEgressTitle(net.egress) +
        "." +
        (machine !== undefined ? ` ${declaredMachineTitle(machine)}.` : "") +
        (armed ? " The host refuses connections from this machine that it did not declare." : "") +
        // The title itself now carries the ownership ("which it creates for you") — the
        // founder's point: a bare "servers"/"websites" reads as the DEVELOPER'S. The
        // purpose framing lives once, in the advanced row's context.
        (infra ? ` ${infra}.` : ""),
    });
  } else if (canDeployCloudCompute(ps)) {
    // Transition truth (2026-09-01, the founder's correction): the catalogue refuses
    // new listings and updates without a declaration, so an undeclared poppy a user
    // HAS is, by definition, one packaged before the rule existed — the age of its
    // manifest, not evasion. The card must say that, or seven first-party poppies
    // read as warnings on the day the rule ships.
    rows.push({
      id: "egress",
      label: "Data exits",
      state: "undeclared",
      stateWord: "Not yet declared",
      sentence:
        "Doesn't yet say where its cloud code connects — this version was packaged before declaring became required (September 2026). The catalogue requires the declaration at its next update.",
    });
  } else {
    rows.push({
      id: "egress",
      label: "Data exits",
      state: "declared",
      stateWord: "No cloud code",
      sentence: "Runs no cloud code of its own, so there is nothing in your cloud for it to send data from.",
    });
  }

  rows.push(
    ctx.supervised
      ? {
          id: "approval",
          label: "Your approval",
          state: "enforced",
          stateWord: "Supervised",
          sentence: `Changes beyond its own resources wait for your approval, and an unanswered request expires after ${APPROVAL_WINDOW_MINUTES} minutes.`,
        }
      : {
          id: "approval",
          label: "Your approval",
          state: "off",
          stateWord: "Off",
          sentence: "Supervision is switched off for this connection — you can turn it back on above.",
        },
  );

  rows.push(
    labellingEnforced
      ? {
          id: "exit",
          label: "Your exit",
          state: "enforced",
          stateWord: "Enforced",
          sentence: "One click removes everything — AWS refuses to let it create anything unlabelled, so the sweep finds all of it. And you can cut every poppy off at once, any time.",
        }
      : {
          id: "exit",
          label: "Your exit",
          state: "partial",
          stateWord: "Sweep + stacks",
          sentence: "One click deletes the stacks it created and sweeps for anything labelled as its own. And you can cut every poppy off at once, any time.",
        },
  );

  rows.push({
    id: "record",
    label: "The record",
    state: "enforced",
    stateWord: "Enforced",
    sentence: "Everything it does in your cloud is recorded, and it can never switch the record off.",
  });

  rows.push({
    id: "limits",
    label: "Hard limits",
    state: "enforced",
    stateWord: "Enforced",
    sentence: "It can never manage the people in your account, grant itself admin, or touch account settings — AWS refuses these outright.",
  });

  return rows;
}
