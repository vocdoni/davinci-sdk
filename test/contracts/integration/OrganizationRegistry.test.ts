// test/integration/OrganizationRegistry.test.ts
import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from test/.env
config({ path: resolve(__dirname, '../../.env') });
import { JsonRpcProvider, Wallet } from 'ethers';
import { OrganizationRegistryService, SmartContractService, deployedAddresses as addresses } from '../../../src/contracts';

jest.setTimeout(Number(process.env.TIME_OUT) || 60000);

const provider = new JsonRpcProvider(process.env.SEPOLIA_RPC!);
provider.pollingInterval = 1_000;
const wallet = new Wallet(process.env.PRIVATE_KEY!, provider);
const contractAddress = addresses.organizationRegistry.sepolia;

describe('OrganizationRegistryService Integration (Sepolia)', () => {
    const admin = wallet.address;
    const service = new OrganizationRegistryService(contractAddress, wallet);

    const orgId = Wallet.createRandom().address;
    const name = `TestOrg-${Date.now()}`;
    const metadataURI = 'ipfs://test-meta';
    const updatedMetadata = 'ipfs://updated-meta';
    let extraAdmin: string;

    afterAll(() => {
        service.removeAllListeners();
    });

    it('should run full organization lifecycle and emit events', async () => {
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
