/**
 * @fileoverview Organizer calls the registry must refuse, made through the
 * SDK's raw registry service: its simulation (`eth_call`) refuses them before
 * anything is signed, with the registry error named.
 */

import { expect } from 'vitest';
import type { ContractServiceError } from '../../../src/contracts/errors';
import { TxStatus, type TxStatusEvent } from '../../../src/contracts/SmartContractService';
import { say } from '../env';
import type { Live } from './context';

/**
 * Runs `stream` while no other organizer transaction is in flight and
 * returns the error its simulation ended with; the account's nonce must not
 * move, so nothing was sent.
 */
export async function refusedByCall(
  live: Live,
  label: string,
  stream: () => AsyncGenerator<TxStatusEvent<unknown>>
): Promise<ContractServiceError> {
  return live.org.exclusive(async () => {
    const provider = live.sdk.provider;
    const account = live.wallet.address;
    const before = await provider.getTransactionCount(account, 'pending');
    const events: TxStatusEvent<unknown>[] = [];
    for await (const event of stream()) events.push(event);
    expect(await provider.getTransactionCount(account, 'pending'), `${label}: nothing sent`).toBe(
      before
    );
    const [only] = events;
    expect(events.length, `${label}: one event`).toBe(1);
    if (only.status !== TxStatus.Failed) throw new Error(`${label}: ${only.status}, not refused`);
    const err = only.error as ContractServiceError;
    say(`${label}: refused, ${err.revertName ?? err.message}`);
    return err;
  });
}
