// test/integration/OrganizationRegistry.test.ts
import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from test/.env
config({ path: resolve(__dirname, '../../.env') });
import { JsonRpcProvider, Wallet } from 'ethers';
import {
  OrganizationRegistryService,
  SmartContractService,
  CreateOrganizationError,
  deployedAddresses as addresses,
} from '../../../src/contracts';

jest.setTimeout(Number(process.env.TIME_OUT) || 60000);

const provider = new JsonRpcProvider(process.env.SEPOLIA_RPC!);
provider.pollingInterval = 1_000;
const wallet = new Wallet(process.env.PRIVATE_KEY!, provider);
const contractAddress = addresses.organizationRegistry.sepolia;

const admin = wallet.address;
const service = new OrganizationRegistryService(contractAddress, wallet);

describe('OrganizationRegistryService Integration (Sepolia)', () => {
  let extraAdmin: string;

  it('should yield correct transaction status events when creating organization', async () => {
    // Ensure any leftover org is cleaned up before tests run
    try {
      // This will either complete (org deleted) or throw on revert (org didn't exist)
      await SmartContractService.executeTx(
        service.deleteOrganization(admin)
      );
    } catch {
      // ignore whatever went wrong (likely: org wasn’t there)
    }

    // before create, org should not exist
    expect(await service.existsOrganization(admin)).toBe(false);

    const name = `TestOrg-${Date.now()}-1`;
    const metadataURI = `ipfs://test-meta-${Date.now()}-1`;
    const txStream = service.createOrganization(name, metadataURI, [admin]);

    for await (const event of txStream) {
      switch (event.status) {
        case 'pending':
          expect(event.hash).toBeDefined();
          expect(typeof event.hash).toBe('string');
          expect(event.hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
          break;

        case 'completed':
          expect(event.response).toEqual({ success: true });

          // Verify the organization was actually created
          const org = await service.getOrganization(admin);
          expect(org.name).toBe(name);
          expect(org.metadataURI).toBe(metadataURI);
          expect(await service.isAdministrator(admin, admin)).toBe(true);
          // now org should exist
          expect(await service.existsOrganization(admin)).toBe(true);
          break;

        case 'reverted':
          fail('Transaction should not revert');
          break;

        case 'failed':
          fail('Transaction should not fail');
          break;
      }
    }
  });

  it('should yield failure status when creating organization with invalid parameters', async () => {
    // Ensure any leftover org is cleaned up before tests run
    try {
      // This will either complete (org deleted) or throw on revert (org didn't exist)
      await SmartContractService.executeTx(
        service.deleteOrganization(admin)
      );
    } catch {
      // ignore whatever went wrong (likely: org wasn’t there)
    }

    const metadataURI = `ipfs://test-meta-${Date.now()}-2`;
    const txStream = service.createOrganization('', metadataURI, [admin]);

    let eventCount = 0;
    for await (const event of txStream) {
      eventCount++;

      if (event.status === 'failed') {
        expect(event.error).toBeInstanceOf(CreateOrganizationError);
      } else {
        fail(`Expected failed status but got ${event.status}`);
      }
    }

    expect(eventCount).toBe(1);

    // Org still should not exist
    expect(await service.existsOrganization(admin)).toBe(false);

    // Verify the organization was not created
    const org = await service.getOrganization(admin);
    expect(org.name).toBe('');
    expect(org.metadataURI).toBe('');
  });

  afterAll(() => {
    service.removeAllListeners();
  });

  it('should run full organization lifecycle, emit events, and handle existence & admin events', async () => {
    // Ensure any leftover org is cleaned up before tests run
    try {
      // This will either complete (org deleted) or throw on revert (org didn't exist)
      await SmartContractService.executeTx(
        service.deleteOrganization(admin)
      );
    } catch {
      // ignore whatever went wrong (likely: org wasn’t there)
    }

    const name = `TestOrg-${Date.now()}-3`;
    const metadataURI = `ipfs://test-meta-${Date.now()}-3`;
    const updatedMetadata = `ipfs://updated-meta-${Date.now()}-3`;

    //
    // 1) wait for OrganizationCreated
    //
    const createdPromise = new Promise<void>((resolve) => {
      service.onOrganizationCreated((id: string) => {
        if (id.toLowerCase() === admin.toLowerCase()) {
          resolve();
        }
      });
    });

    // fire the tx
    await SmartContractService.executeTx(
      service.createOrganization(name, metadataURI, [admin])
    );
    await createdPromise;

    // confirm on‐chain state
    const created = await service.getOrganization(admin);
    expect(created.name).toBe(name);
    expect(created.metadataURI).toBe(metadataURI);
    expect(await service.isAdministrator(admin, admin)).toBe(true);
    expect(await service.existsOrganization(admin)).toBe(true);

    //
    // 2) wait for OrganizationUpdated
    //
    const updatedPromise = new Promise<void>((resolve) => {
      service.onOrganizationUpdated((id: string, updater: string) => {
        if (
          id.toLowerCase() === admin.toLowerCase() &&
          updater.toLowerCase() === admin.toLowerCase()
        ) {
          resolve();
        }
      });
    });

    await SmartContractService.executeTx(
      service.updateOrganization(admin, name, updatedMetadata)
    );
    await updatedPromise;

    const updated = await service.getOrganization(admin);
    expect(updated.metadataURI).toBe(updatedMetadata);

    //
    // 3) add & remove an extra admin with event listeners
    //
    extraAdmin = Wallet.createRandom().address;

    const addedPromise = new Promise<void>((resolve) => {
      service.onAdministratorAdded((id: string, administrator: string) => {
        if (
          id.toLowerCase() === admin.toLowerCase() &&
          administrator.toLowerCase() === extraAdmin.toLowerCase()
        ) {
          resolve();
        }
      });
    });

    await SmartContractService.executeTx(
      service.addAdministrator(admin, extraAdmin)
    );
    await addedPromise;
    expect(await service.isAdministrator(admin, extraAdmin)).toBe(true);

    const removedPromise = new Promise<void>((resolve) => {
      service.onAdministratorRemoved(
        (id: string, administrator: string, remover: string) => {
          if (
            id.toLowerCase() === admin.toLowerCase() &&
            administrator.toLowerCase() === extraAdmin.toLowerCase() &&
            remover.toLowerCase() === admin.toLowerCase()
          ) {
            resolve();
          }
        }
      );
    });

    await SmartContractService.executeTx(
      service.removeAdministrator(admin, extraAdmin)
    );
    await removedPromise;
    expect(await service.isAdministrator(admin, extraAdmin)).toBe(false);

    //
    // 4) delete org
    //
    await SmartContractService.executeTx(
      service.deleteOrganization(admin)
    );
    const deleted = await service.getOrganization(admin);
    expect(deleted.name).toBe('');
    // after delete, org should not exist
    expect(await service.existsOrganization(admin)).toBe(false);
  });
});
