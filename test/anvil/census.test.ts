import { toBeHex, zeroPadValue } from 'ethers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DavinciSDK } from '../../src/DavinciSDK';
import { CspSigner } from '../../src/census/CspSigner';
import { OffchainCensus } from '../../src/census/classes/OffchainCensus';
import { OffchainDynamicCensus } from '../../src/census/classes/OffchainDynamicCensus';
import { OnchainCensus } from '../../src/census/classes/OnchainCensus';
import { CensusError, CensusPublishError, CensusWitnessError } from '../../src/census/errors';
import { CensusOrigin } from '../../src/census/types';
import { OnchainCensusService } from '../../src/contracts/OnchainCensusService';
import {
  CensusContractError,
  CensusNotUpdatable,
  ProcessCensusError,
} from '../../src/contracts/errors';
import { SmartContractService } from '../../src/contracts/SmartContractService';
import { slotFromAddress } from '../../src/crypto/census';
import {
  acrossTheEnd,
  addresses,
  connect,
  deployOwnedCensus,
  devWallet,
  election,
  startNode,
  streamError,
  type MockNode,
} from './harness';

const ACCOUNT = 4;
const CENSUS_OWNER = 15;
const CSP_KEY = 16;
const STRANGER = 17;

describe('censuses', () => {
  let node: MockNode;
  let sdk: DavinciSDK;

  beforeAll(async () => {
    node = await startNode();
    sdk = await connect(ACCOUNT, node);
  });

  afterAll(async () => {
    await sdk.cancelOpenProcesses({ all: true });
    await node.close();
  });

  describe('an on-chain census contract (origin 3)', () => {
    let contract: string;
    let owner: OnchainCensusService;
    const [a, b, c, late] = addresses(4);

    beforeAll(async () => {
      contract = await deployOwnedCensus(devWallet(CENSUS_OWNER));
      owner = new OnchainCensusService(contract, devWallet(CENSUS_OWNER));
      await SmartContractService.executeTx(owner.addMembers([a, b, c], [1, 2, 3]));
    });

    it('reads the contract and checks it is an append-only census', async () => {
      const census = new OnchainCensusService(contract, sdk.provider);
      const state = await census.check();
      expect(state.size).toBe(3);
      expect(state.root).toBe(await census.getCensusRoot());
      expect(await census.weightOf(b)).toBe(2n);
      expect(await census.weightOf(late)).toBe(0n);
      expect(await census.totalVotingPower()).toBe(6n);
      expect(await census.slotOf(a)).toBe(slotFromAddress(a));
      expect(await census.slotOwner(slotFromAddress(a))).toBe(a);
      expect(await census.slotOwner(slotFromAddress(late))).toBeNull();
    });

    it('decodes the census contract reverts', async () => {
      const again = await streamError(owner.addMember(a, 1));
      expect(again).toBeInstanceOf(CensusContractError);
      expect(again).toMatchObject({ revertName: 'AlreadyRegisteredAddress' });
      const stranger = new OnchainCensusService(contract, devWallet(STRANGER));
      expect(await streamError(stranger.addMember(late, 1))).toMatchObject({
        revertName: 'OwnableUnauthorizedAccount',
      });
      // Refused before simulating.
      expect(await streamError(owner.addMember(late, 0))).toBeInstanceOf(CensusContractError);
      expect(await streamError(owner.addMembers([late], [1, 2]))).toBeInstanceOf(
        CensusContractError
      );
    });

    it('creates a process on it and reads weights, members added later included', async () => {
      const onchain = new OnchainCensus(contract);
      const { processId } = await sdk.createProcess(election(onchain, { maxVoters: 10 }));
      const p = await sdk.getProcess(processId);
      expect(p.census).toMatchObject({
        type: CensusOrigin.Onchain,
        contractAddress: contract,
        root: toBeHex(await owner.getCensusRoot(), 32),
      });

      expect(await sdk.getAddressWeight(processId, b)).toBe(2n);
      expect(await sdk.isAddressAbleToVote(processId, late)).toBe(false);
      await SmartContractService.executeTx(owner.addMember(late, 7));
      expect(await sdk.getAddressWeight(processId, late)).toBe(7n);
      expect(await onchain.witness(sdk.provider, late)).toEqual({ type: 'merkle', weight: 7n });
      await expect(onchain.witness(sdk.provider, addresses(1)[0])).rejects.toBeInstanceOf(
        CensusWitnessError
      );
      // Nobody has voted: every node answers so.
      expect(await sdk.hasAddressVoted(processId, b)).toBe(false);

      // Its members come from the contract: the census is not replaced.
      const replaced = await streamError(
        sdk.updateCensusStream(processId, {
          root: p.census.root,
          uri: 'https://files.example.org/c.json',
        })
      );
      expect(replaced).toBeInstanceOf(CensusNotUpdatable);
    });
  });

  describe('an updatable census (origin 2)', () => {
    it('moves the process to new census versions until the end', async () => {
      const [a, b, c] = addresses(3);
      const census = new OffchainDynamicCensus();
      census.add([a, b]);
      const { processId } = await sdk.createProcess(election(census, { maxVoters: 10 }));
      expect(await sdk.getAddressWeight(processId, a)).toBe(1n);
      expect(await sdk.isAddressAbleToVote(processId, c)).toBe(false);

      census.add({ key: c, weight: 4 });
      census.remove(b);
      expect(census.isPublished).toBe(false);
      await sdk.updateCensus(processId, census);
      expect(census.isPublished).toBe(true);
      const p = await sdk.getProcess(processId);
      expect(p.census).toMatchObject({ root: await census.root(), uri: census.censusURI });
      expect(await sdk.getAddressWeight(processId, c)).toBe(4n);
      expect(await sdk.getAddressWeight(processId, b)).toBe(0n);

      // A file already served, checked as nodes read it.
      const next = new OffchainDynamicCensus();
      next.add([a, b, c]);
      const url = node.serve('/v3/census.json', next.serialize());
      await sdk.updateCensus(processId, { root: await next.root(), uri: url });
      expect((await sdk.registry.getProcess(processId)).census.root).toBe(await next.root());
      const wrong = await streamError(
        sdk.updateCensusStream(processId, { root: await census.root(), uri: url })
      );
      expect(wrong).toBeInstanceOf(CensusPublishError);

      // The new version must be updatable too.
      const fixed = new OffchainCensus();
      fixed.add([a]);
      expect(await streamError(sdk.updateCensusStream(processId, fixed))).toBeInstanceOf(
        CensusError
      );

      // The registry's own checks of the new census.
      const root = await next.root();
      for (const [change, revertName] of [
        [{ origin: CensusOrigin.OffchainStatic, root, uri: url }, 'InvalidCensusOrigin'],
        [{ origin: CensusOrigin.OffchainDynamic, root: 0n, uri: url }, 'InvalidCensusRoot'],
        [{ origin: CensusOrigin.OffchainDynamic, root, uri: '' }, 'InvalidCensusURI'],
      ] as const) {
        const err = await streamError(sdk.processes.setProcessCensus(processId, change));
        expect(err, revertName).toBeInstanceOf(ProcessCensusError);
        expect(err, revertName).toMatchObject({ revertName });
      }

      const end = await sdk.registry.getProcessEndTime(processId);
      await acrossTheEnd(
        end,
        () => sdk.updateCensusStream(processId, { root, uri: url }),
        () =>
          sdk.processes.setProcessCensus(processId, {
            origin: CensusOrigin.OffchainDynamic,
            root,
            uri: url,
          })
      );
    });

    it('does not replace a static census', async () => {
      const census = new OffchainCensus();
      census.add([{ key: addresses(1)[0], weight: 9 }, addresses(1)[0]]);
      const { processId } = await sdk.createProcess(election(census));
      expect(await sdk.getAddressWeight(processId, census.addresses[0])).toBe(9n);
      const update = { root: await census.root(), uri: census.censusURI ?? '' };
      const local = await streamError(sdk.updateCensusStream(processId, update));
      expect(local).toBeInstanceOf(CensusNotUpdatable);
      expect(local).toMatchObject({ revertName: 'CensusNotUpdatable' });
      const raw = await streamError(
        sdk.processes.setProcessCensus(processId, {
          origin: CensusOrigin.OffchainDynamic,
          ...update,
        })
      );
      expect(raw).toBeInstanceOf(CensusNotUpdatable);
      expect(raw.message).toMatch(/reverted: CensusNotUpdatable/);
    });
  });

  describe('a CSP census (origin 4)', () => {
    it('takes the attestations of the CSP whose address is the root', async () => {
      const csp = new CspSigner(devWallet(CSP_KEY));
      const census = await csp.census('https://csp.example.org/elections');
      expect(census.censusRoot).toBe(zeroPadValue(await csp.address(), 32).toLowerCase());
      const { processId } = await sdk.createProcess(election(census, { maxVoters: 10 }));
      const [voter] = addresses(1);

      const withCsp = await connect(ACCOUNT, node, {
        config: {
          censusProviders: {
            csp: req => csp.attest({ processId: req.processId, address: req.address, weight: 3n }),
          },
        },
      });
      expect(await withCsp.getAddressWeight(processId, voter)).toBe(3n);
      expect(await withCsp.isAddressAbleToVote(processId, voter)).toBe(true);

      // Another key's attestation is not this census's.
      const impostor = new CspSigner(devWallet(STRANGER));
      const withImpostor = await connect(ACCOUNT, node, {
        config: {
          censusProviders: {
            csp: req => impostor.attest({ processId: req.processId, address: req.address }),
          },
        },
      });
      await expect(withImpostor.getAddressWeight(processId, voter)).rejects.toBeInstanceOf(
        CensusWitnessError
      );
      await expect(sdk.getAddressWeight(processId, voter)).rejects.toThrow(/censusProviders.csp/);
    });
  });
});
