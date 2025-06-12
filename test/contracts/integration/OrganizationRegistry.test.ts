// test/integration/OrganizationRegistry.test.ts
import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from test/.env
config({ path: resolve(__dirname, '../../.env') });
import { JsonRpcProvider, Wallet } from 'ethers';
import { OrganizationRegistryService, SmartContractService, CreateOrganizationError, deployedAddresses as addresses } from '../../../src/contracts';

jest.setTimeout(Number(process.env.TIME_OUT) || 60000);

const provider = new JsonRpcProvider(process.env.SEPOLIA_RPC!);
provider.pollingInterval = 1_000;
const wallet = new Wallet(process.env.PRIVATE_KEY!, provider);
const contractAddress = addresses.organizationRegistry.sepolia;

describe('OrganizationRegistryService Integration (Sepolia)', () => {
    const admin = wallet.address;
    const service = new OrganizationRegistryService(contractAddress, wallet);
    let extraAdmin: string;

    it('should yield correct transaction status events when creating organization', async () => {
        const orgId = Wallet.createRandom().address;
        const name = `TestOrg-${Date.now()}-1`;
        const metadataURI = `ipfs://test-meta-${Date.now()}-1`;
        const txStream = service.createOrganization(orgId, name, metadataURI, [admin]);
        
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
                    const org = await service.getOrganization(orgId);
                    expect(org.name).toBe(name);
                    expect(org.metadataURI).toBe(metadataURI);
                    expect(await service.isAdministrator(orgId, admin)).toBe(true);
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
        const orgId = Wallet.createRandom().address;
        const metadataURI = `ipfs://test-meta-${Date.now()}-2`;
        // Try to create org with empty name which should fail
        const txStream = service.createOrganization(orgId, '', metadataURI, [admin]);
        
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
        
        // Verify the organization was not created
        const org = await service.getOrganization(orgId);
        expect(org.name).toBe('');
        expect(org.metadataURI).toBe('');
    });

    afterAll(() => {
        service.removeAllListeners();
    });

    it('should run full organization lifecycle and emit events', async () => {
        const orgId = Wallet.createRandom().address;
        const name = `TestOrg-${Date.now()}-3`;
        const metadataURI = `ipfs://test-meta-${Date.now()}-3`;
        const updatedMetadata = `ipfs://updated-meta-${Date.now()}-3`;

        //
        // 1) wait for OrganizationCreated
        //
        const createdPromise = new Promise<void>((resolve) => {
            service.onOrganizationCreated((id: string, creator: string) => {
                if (
                    id.toLowerCase() === orgId.toLowerCase() &&
                    creator.toLowerCase() === admin.toLowerCase()
                ) {
                    resolve();
                }
            });
        });

        // fire the tx
        await SmartContractService.executeTx(
            service.createOrganization(orgId, name, metadataURI, [admin])
        );
        // await the event
        await createdPromise;

        // confirm on‐chain state
        const created = await service.getOrganization(orgId);
        expect(created.name).toBe(name);
        expect(created.metadataURI).toBe(metadataURI);

        expect(await service.isAdministrator(orgId, admin)).toBe(true);

        //
        // 2) wait for OrganizationUpdated
        //
        const updatedPromise = new Promise<void>((resolve) => {
            service.onOrganizationUpdated((id: string, updater: string) => {
                if (
                    id.toLowerCase() === orgId.toLowerCase() &&
                    updater.toLowerCase() === admin.toLowerCase()
                ) {
                    resolve();
                }
            });
        });

        await SmartContractService.executeTx(
            service.updateOrganization(orgId, name, updatedMetadata)
        );
        await updatedPromise;

        const updated = await service.getOrganization(orgId);
        expect(updated.metadataURI).toBe(updatedMetadata);

        //
        // 3) add & remove an extra admin
        //
        extraAdmin = Wallet.createRandom().address;
        await SmartContractService.executeTx(
            service.addAdministrator(orgId, extraAdmin)
        );
        expect(await service.isAdministrator(orgId, extraAdmin)).toBe(true);

        await SmartContractService.executeTx(
            service.removeAdministrator(orgId, extraAdmin)
        );
        expect(await service.isAdministrator(orgId, extraAdmin)).toBe(false);

        //
        // 4) delete org
        //
        await SmartContractService.executeTx(
            service.deleteOrganization(orgId)
        );
        const deleted = await service.getOrganization(orgId);
        expect(deleted.name).toBe('');
    });
});
