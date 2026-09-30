import { Interface, Wallet, ZeroAddress, getAddress } from 'ethers';
import {
  CensusContractError,
  OWNED_CENSUS_ABI,
  OnchainCensusService,
  SmartContractService,
  TxStatus,
  type TxStatusEvent,
} from '../../../src/contracts';
import { slotFromAddress } from '../../../src/crypto';
import { MockChain, revertWith, type CallHandler } from '../../helpers/mockChain';

const CONTRACT = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const KEY = `0x${'11'.repeat(32)}`;
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const iface = new Interface(OWNED_CENSUS_ABI);

function setup(calls: Record<string, CallHandler> = {}) {
  const chain = new MockChain();
  const owner = new Wallet(KEY, chain);
  chain.contract(CONTRACT, OWNED_CENSUS_ABI, {
    getCensusRoot: () => [77n],
    treeSize: () => [2n],
    weightOf: args => [(args[0] as string) === getAddress(A) ? 3n : 0n],
    slotOf: args => [slotFromAddress(args[0] as string)],
    slotOwner: args => [(args[0] as bigint) === slotFromAddress(A) ? A : ZeroAddress],
    totalVotingPower: () => [5n],
    addMember: () => [],
    addMembers: () => [],
    ...calls,
  });
  const census = new OnchainCensusService(CONTRACT, owner, { receiptTimeoutMs: 2000 });
  return { chain, owner, census };
}

async function drain<T>(stream: AsyncGenerator<TxStatusEvent<T>>): Promise<TxStatusEvent<T>[]> {
  const out: TxStatusEvent<T>[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe('OnchainCensusService', () => {
  it('reads the census', async () => {
    const { census } = setup();
    expect(census.address).toBe(getAddress(CONTRACT));
    expect(await census.getCensusRoot()).toBe(77n);
    expect(await census.treeSize()).toBe(2);
    expect(await census.weightOf(A)).toBe(3n);
    expect(await census.weightOf(B)).toBe(0n);
    expect(await census.slotOf(B)).toBe(slotFromAddress(B));
    expect(await census.slotOwner(slotFromAddress(A))).toBe(getAddress(A));
    expect(await census.slotOwner(slotFromAddress(B))).toBeNull();
    expect(await census.totalVotingPower()).toBe(5n);
    expect(await census.check()).toEqual({ root: 77n, size: 2 });
  });

  it('adds members as the owner', async () => {
    const { chain, census } = setup();
    await SmartContractService.executeTx(census.addMember(A, 4n));
    await SmartContractService.executeTx(census.addMembers([A, B], [1, 2n]));
    const [one, many] = chain.sent.map(tx => iface.parseTransaction({ data: tx.data }));
    expect(one?.name).toBe('addMember');
    expect([...(one?.args ?? [])]).toEqual([getAddress(A), 4n]);
    expect(many?.name).toBe('addMembers');
    expect(many?.args[0]).toEqual([getAddress(A), getAddress(B)]);
    expect(many?.args[1]).toEqual([1n, 2n]);
  });

  it('refuses a weight outside [1, 2^88) and mismatched lists before any request', async () => {
    const { chain, census } = setup();
    for (const [stream, msg] of [
      [census.addMember(A, 0), 'weight 0 is not in [1, 2^88)'],
      [census.addMember(A, 1n << 88n), 'is not in [1, 2^88)'],
      [census.addMembers([A, B], [1]), '2 users and 1 weights'],
    ] as const) {
      const events = await drain(stream);
      const last = events[events.length - 1];
      expect(last.status).toBe(TxStatus.Failed);
      expect(last.status === TxStatus.Failed && last.error.message).toContain(msg);
    }
    expect(chain.calls('eth_call')).toHaveLength(0);
    expect(chain.sent).toHaveLength(0);
  });

  it('names the census contract errors', async () => {
    const { census } = setup({
      addMember: () => revertWith(OWNED_CENSUS_ABI, 'SlotTaken', [A]),
      addMembers: () => revertWith(OWNED_CENSUS_ABI, 'OwnableUnauthorizedAccount', [B]),
    });
    const taken = await SmartContractService.executeTx(census.addMember(B, 1)).catch(
      (e: unknown) => e as CensusContractError
    );
    expect(taken).toBeInstanceOf(CensusContractError);
    expect((taken as CensusContractError).revertName).toBe('SlotTaken');
    expect((taken as CensusContractError).revert?.args[0]).toBe(getAddress(A));
    const unauthorized = await SmartContractService.executeTx(census.addMembers([B], [1])).catch(
      (e: unknown) => e as CensusContractError
    );
    expect((unauthorized as CensusContractError).revertName).toBe('OwnableUnauthorizedAccount');
  });

  it('wraps a failed read', async () => {
    const { census } = setup({
      weightOf: () => revertWith(OWNED_CENSUS_ABI, 'InvalidCensusWeight'),
    });
    await expect(census.weightOf(A)).rejects.toThrow(CensusContractError);
  });
});
