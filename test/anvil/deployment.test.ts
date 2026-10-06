import { Contract, ZeroHash } from 'ethers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAVINCI_DKG_ADAPTER_ABI } from '../../src/contracts/abis';
import { DeploymentPinError, DkgDisabledError } from '../../src/contracts/errors';
import { processIdPrefix } from '../../src/networks';
import { RELEASE_PINS } from '../../src/protocol/release';
import { NodeMismatchError } from '../../src/sequencer/errors';
import { ANVIL_CHAIN_ID } from './env';
import {
  ANVIL_GRACE,
  anvil,
  chainProvider,
  connect,
  registryService,
  startNode,
  unusedUrl,
  type MockNode,
} from './harness';

const ACCOUNT = 1;

describe('the anvil deployment', () => {
  let node: MockNode;

  beforeAll(async () => {
    node = await startNode();
  });

  afterAll(() => node.close());

  it('pins what this release proves', async () => {
    const registry = registryService(chainProvider());
    const info = await registry.verifyDeployment();
    expect(info.chainId).toBe(BigInt(ANVIL_CHAIN_ID));
    expect(info.dkgAdapter).toBeNull();
    expect(info.councilAdapter).toBeNull();
    expect(await registry.getZiskVerifier()).toBe(info.verifier);
    expect(await registry.getBallotVKHash()).toBe(RELEASE_PINS.ballotVKHash);
    expect(await registry.getGraceParams()).toEqual(ANVIL_GRACE);
    expect(await registry.getPidPrefix()).toBe(processIdPrefix(ANVIL_CHAIN_ID, anvil().registry));
  });

  it('names the first pin that differs', async () => {
    const registry = registryService(chainProvider());
    const other = `0x${'ab'.repeat(32)}`;
    const err = await registry.verifyDeployment({ ballotVKHash: other }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeploymentPinError);
    expect(err).toMatchObject({ field: 'ballotVKHash', expected: other });
    const code = await registry
      .verifyDeployment({ ziskVerifierCodeHash: ZeroHash })
      .catch((e: unknown) => e);
    expect(code).toMatchObject({ field: 'verifier code hash', expected: ZeroHash });
  });

  it('checks the adapter of a registry with a DKG manager points back at it', async () => {
    const registry = registryService(chainProvider(), 'dkg');
    const info = await registry.verifyDeployment();
    expect(info.dkgAdapter).not.toBeNull();
    const adapter = new Contract(
      info.dkgAdapter as string,
      DAVINCI_DKG_ADAPTER_ABI,
      chainProvider()
    );
    expect(await adapter.getFunction('registry').staticCall()).toBe(anvil().dkgRegistry);
    expect(await adapter.getFunction('manager').staticCall()).toBe(anvil().mockDkg);
  });

  it('refuses the DKG reads of a registry without a DKG manager', async () => {
    const registry = registryService(chainProvider());
    const pid = await registry.getNextProcessId(anvil().registry);
    expect(await registry.getDkgAdapter()).toBeNull();
    await expect(registry.aidFor(pid)).rejects.toMatchObject({
      name: 'DkgDisabledError',
      revertName: 'DKGDisabled',
    });
    await expect(registry.getRegistrationEpoch()).rejects.toBeInstanceOf(DkgDisabledError);
  });

  it('connects the SDK to the registry and the node', async () => {
    const sdk = await connect(ACCOUNT, node);
    expect(sdk.nodeChecks).toEqual([expect.objectContaining({ url: node.url, status: 'usable' })]);
    expect(sdk.network.processIdPrefix).toBe(await sdk.registry.getPidPrefix());
    expect(await sdk.getGraceParams()).toEqual(ANVIL_GRACE);
    expect(node.requests).toContain('GET /info');
  });

  it('fails init on registry pins other than the ones asked for', async () => {
    const other = `0x${'cd'.repeat(32)}`;
    await expect(
      connect(ACCOUNT, node, { config: { verifyDeployment: { pins: { batchProgramVK: other } } } })
    ).rejects.toMatchObject({ name: 'DeploymentPinError', field: 'batchProgramVK' });
  });

  it('fails init on a node of another deployment', async () => {
    const other = await startNode();
    try {
      other.info = { ballotVkHash: `0x${'ee'.repeat(32)}` };
      const err = await connect(ACCOUNT, other).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NodeMismatchError);
      expect(err).toMatchObject({ field: 'ballotVkHash' });
      other.info = { processRegistry: anvil().dkgRegistry };
      await expect(connect(ACCOUNT, other)).rejects.toMatchObject({ field: 'processRegistry' });
    } finally {
      await other.close();
    }
  });

  it('reads through the next RPC when the first does not answer', async () => {
    const sdk = await connect(ACCOUNT, node, {
      config: { rpcUrls: [await unusedUrl(), anvil().rpcUrl] },
    });
    expect(await sdk.registry.getChainID()).toBe(String(ANVIL_CHAIN_ID));
  });

  it('leaves a node that is down out, and still reads the registry', async () => {
    const down = await unusedUrl();
    const sdk = await connect(ACCOUNT, node, { config: { sequencerUrls: [node.url, down] } });
    expect(sdk.nodeChecks.find(c => c.url === down)).toMatchObject({ status: 'down' });
    expect(sdk.nodeChecks.find(c => c.url === node.url)).toMatchObject({ status: 'usable' });
  });
});
