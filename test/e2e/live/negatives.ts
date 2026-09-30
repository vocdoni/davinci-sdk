/**
 * @fileoverview Organizer calls the registry must refuse, made through the
 * SDK's raw registry service as the organizer's address with a signer that
 * cannot sign: the service's simulation (`eth_call`) names the registry's
 * refusal, and nothing can be sent even if it did not refuse.
 */

import { VoidSigner } from 'ethers';
import { expect } from 'vitest';
import type { ContractServiceError } from '../../../src/contracts/errors';
import { ProcessRegistryService } from '../../../src/contracts/ProcessRegistryService';
import { TxStatus, type TxStatusEvent } from '../../../src/contracts/SmartContractService';
import { say } from '../env';
import type { Live } from './context';

/** The registry as the organizer's address, unable to sign. */
export function callOnly(live: Live): ProcessRegistryService {
  return new ProcessRegistryService(
    live.sdk.network.processRegistry,
    new VoidSigner(live.wallet.address, live.sdk.provider)
  );
}

/**
 * Returns the error the simulation of `stream` ended with: its only event
 * is `failed` (a sent transaction would have yielded `pending` first), with
 * the registry error decoded from the `eth_call`.
 */
export async function refusedByCall(
  label: string,
  stream: () => AsyncGenerator<TxStatusEvent<unknown>>
): Promise<ContractServiceError> {
  const events: TxStatusEvent<unknown>[] = [];
  for await (const event of stream()) events.push(event);
  expect(
    events.map(e => e.status),
    `${label}: refused by the simulation`
  ).toEqual([TxStatus.Failed]);
  const [only] = events;
  if (only.status !== TxStatus.Failed) throw new Error(`${label}: ${only.status}`);
  const err = only.error as ContractServiceError;
  expect((err.cause as { code?: string } | undefined)?.code, `${label}: an eth_call revert`).toBe(
    'CALL_EXCEPTION'
  );
  say(`${label}: refused, ${err.revertName ?? err.message}`);
  return err;
}
