/**
 * @fileoverview Shared checks: the SDK refusing a ballot past a ballot-mode
 * boundary (its checker and its prover both), and the node's `/info` counters
 * that must not move when every admitted vote is valid.
 */

import type { BaseWallet } from 'ethers';
import { buildBallot } from '../../../src/crypto/ballot';
import { checkBallot } from '../../../src/crypto/ballotChecker';
import { randomBallotSecret } from '../../../src/crypto/encryption';
import { BallotProofError } from '../../../src/prover/errors';
import type { ProcessCtx } from './ballots';
import type { Live } from './live';

/** The SDK takes `choices` at `weight`: the checker passes (the vote is then sent and checked by the node). */
export function sdkTakes(
  live: Live,
  ctx: ProcessCtx,
  name: string,
  choices: number[],
  weight: bigint
) {
  const r = checkBallot(choices, ctx.ballotMode, weight);
  return live.ev.check(
    `${name}: the SDK checker takes [${choices.join(',')}] at weight ${weight}`,
    r.valid,
    {
      error: r.error,
    }
  );
}

/** The SDK refuses `choices` at `weight`: its checker, and its prover with the checker bypassed. */
export async function sdkRefuses(
  live: Live,
  ctx: ProcessCtx,
  voter: BaseWallet,
  name: string,
  choices: number[],
  weight: bigint
): Promise<void> {
  const r = checkBallot(choices, ctx.ballotMode, weight);
  live.ev.check(
    `${name}: the SDK checker refuses [${choices.join(',')}] at weight ${weight}`,
    !r.valid,
    {
      error: r.error,
    }
  );
  let refused = false;
  let message = 'proved';
  try {
    const b = await buildBallot({
      processId: ctx.processId,
      address: await voter.getAddress(),
      encryptionKey: ctx.encryptionKey,
      ballotMode: ctx.ballotMode,
      fields: choices,
      weight,
      k: randomBallotSecret(),
    });
    await live.sdk.proveBallot(b);
  } catch (err) {
    // The prover's refusal, or the ballot builder's before it (a value past numFields).
    refused = err instanceof BallotProofError || err instanceof RangeError;
    message = err instanceof Error ? err.message.slice(0, 160) : String(err);
  }
  live.ev.check(
    `${name}: the SDK prover refuses [${choices.join(',')}] at weight ${weight}`,
    refused,
    {
      message,
    }
  );
}

const COUNTERS = ['bisections', 'isolatedVotes', 'heldBatches', 'guestRejections'] as const;

export type Counters = Record<(typeof COUNTERS)[number], number>;

export async function counters(live: Live): Promise<Counters> {
  const info = await live.node.info();
  return Object.fromEntries(COUNTERS.map(k => [k, Number(info[k] ?? 0)])) as Counters;
}

/** The failure counters did not move between `before` and now. */
export async function countersStill(live: Live, name: string, before: Counters): Promise<void> {
  const now = await counters(live);
  live.ev.eq(`${name}: /info failure counters did not move`, now, before);
}
