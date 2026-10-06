import { Contract, hexlify, randomBytes, type InterfaceAbi } from 'ethers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DavinciSDK } from '../../src/DavinciSDK';
import { OffchainCensus } from '../../src/census/classes/OffchainCensus';
import { COUNCIL_ADAPTER_ABI } from '../../src/contracts/abis';
import { DkgDisabledError, ProcessCreateError } from '../../src/contracts/errors';
import { KeyMode } from '../../src/contracts/types';
import { bjjMulBase } from '../../src/crypto/babyjubjub';
import {
  addresses,
  anvil,
  chainProvider,
  connect,
  devWallet,
  election,
  startNode,
  streamError,
  type MockNode,
} from './harness';

const ACCOUNT = 10;
// Runs the mock manager, and is the creator no ceremony authorizes.
const OPERATOR = 11;

describe('COUNCIL key mode (davinci-contracts MockCouncilManager)', () => {
  let node: MockNode;
  let sdk: DavinciSDK;
  let council: Contract;
  let adapter: string;
  let census: OffchainCensus;
  // The ceremony key, circomlib TE as Council hands it over.
  const key = bjjMulBase(987_654_321n);

  // A Live ceremony under `key` that allows the adapter and authorizes ACCOUNT.
  async function ceremony(options: { allow?: boolean } = {}): Promise<string> {
    const cid = hexlify(randomBytes(12));
    await (await council.getFunction('newCeremony').send(cid, key.x, key.y)).wait();
    if (options.allow !== false) {
      await (await council.getFunction('allowAdapter').send(cid, adapter)).wait();
    }
    const creator = devWallet(ACCOUNT).address;
    await (await council.getFunction('authorizeCreator').send(cid, creator)).wait();
    return cid;
  }

  const councilElection = (ceremonyId: string) =>
    election(census, { keyMode: 'council', ceremonyId });

  beforeAll(async () => {
    node = await startNode('council');
    sdk = await connect(ACCOUNT, node, { registry: 'council' });
    const a = await sdk.registry.getCouncilAdapter();
    if (!a) throw new Error('the council registry has no Council adapter');
    adapter = a;
    council = new Contract(
      anvil().mockCouncil,
      JSON.parse(anvil().mockCouncilAbi) as InterfaceAbi,
      devWallet(OPERATOR)
    );
    census = new OffchainCensus();
    census.add(addresses(2));
  });

  afterAll(async () => {
    await sdk.cancelOpenProcesses({ all: true });
    await node.close();
  });

  it('pins a Council adapter that points back at the registry', async () => {
    const info = await sdk.registry.verifyDeployment();
    expect(info.dkgAdapter).toBeNull();
    expect(info.councilAdapter).toBe(adapter);
    const a = new Contract(adapter, COUNCIL_ADAPTER_ABI, chainProvider());
    expect(await a.getFunction('registry').staticCall()).toBe(anvil().councilRegistry);
    expect(await a.getFunction('manager').staticCall()).toBe(anvil().mockCouncil);
  });

  it('creates a process bound to the ceremony, under its key', async () => {
    const cid = await ceremony();
    const keys = node.keyRequests.length;
    const { processId, organizerSecret } = await sdk.createProcess(councilElection(cid));
    expect(organizerSecret).toBeUndefined();
    expect(node.keyRequests.length).toBe(keys);

    const requestId = (await council
      .getFunction('requestIdFor')
      .staticCall(cid, adapter, processId)) as string;
    const p = await sdk.getProcess(processId);
    expect(p.keyMode).toBe(KeyMode.Council);
    expect(p.dkg).toEqual({
      locked: false,
      council: true,
      epochId: cid,
      aid: requestId,
      resultsRequested: false,
      firstIndex: 0,
      count: 0,
      zeroSkipped: 0,
    });
    expect(p.raw?.encryptionKey).toEqual(key);

    // The adapter maps the request back to the process; the manager saw the creator.
    const a = new Contract(adapter, COUNCIL_ADAPTER_ABI, chainProvider());
    const binding = (await a.getFunction('bindings').staticCall(requestId)) as unknown[];
    expect([binding[0], binding[1], binding[2]]).toEqual([cid, 0n, processId]);
    expect(await council.getFunction('bindingCreator').staticCall(adapter, processId)).toBe(
      devWallet(ACCOUNT).address
    );
  });

  it('fails a creation the ceremony does not allow with the manager error', async () => {
    const cid = await ceremony();
    const stranger = await connect(OPERATOR, node, { registry: 'council' });
    const notCreator = await streamError(stranger.createProcessStream(councilElection(cid)));
    expect(notCreator).toBeInstanceOf(ProcessCreateError);
    expect(notCreator).toMatchObject({ revertName: 'NotAuthorizedCreator' });

    const unallowed = await ceremony({ allow: false });
    expect(await streamError(sdk.createProcessStream(councilElection(unallowed)))).toMatchObject({
      revertName: 'NotAllowedAdapter',
    });
    await (await council.getFunction('setPhase').send(cid, 2)).wait(); // Dealing
    expect(await streamError(sdk.createProcessStream(councilElection(cid)))).toMatchObject({
      revertName: 'WrongPhase',
    });
    const unknown = hexlify(randomBytes(12));
    expect(await streamError(sdk.createProcessStream(councilElection(unknown)))).toMatchObject({
      revertName: 'UnknownCeremony',
    });
  });

  it('refuses the DKG modes on a registry with Council only', async () => {
    const err = await streamError(sdk.createProcessStream(election(census, { keyMode: 'dkg' })));
    expect(err).toBeInstanceOf(DkgDisabledError);
  });
});
