import {
    OrganizationRegistry__factory,
    type OrganizationRegistry,
} from "@vocdoni/davinci-contracts";
import { SmartContractService } from "./SmartContractService";
import type { ContractRunner } from "ethers";

export class CreateOrganizationError extends Error {}
export class UpdateOrganizationError extends Error {}
export class AdministratorError extends Error {}
export class DeleteOrganizationError extends Error {}

type OrganizationCreatedCallback = (id: string, creator: string) => void;
type OrganizationUpdatedCallback = (id: string, updater: string) => void;

export interface OrganizationInfo {
    name: string;
    metadataURI: string;
}

export class OrganizationRegistryService extends SmartContractService {
    private contract: OrganizationRegistry;

    constructor(contractAddress: string, runner: ContractRunner) {
        super();
        this.contract = OrganizationRegistry__factory.connect(contractAddress, runner);
    }

    async getOrganization(id: string): Promise<OrganizationInfo> {
        const [name, metadataURI] = await this.contract.getOrganization(id);
        return { name, metadataURI };
    }

    async isAdministrator(id: string, address: string): Promise<boolean> {
        return this.contract.isAdministrator(id, address);
    }

    createOrganization(id: string, name: string, metadataURI: string, administrators: string[]) {
        return this.sendTx(
            this.contract.createOrganization(id, name, metadataURI, administrators).catch((e) => {
                throw new CreateOrganizationError(e.message);
            }),
            async () => ({ success: true })
        );
    }

    updateOrganization(id: string, name: string, metadataURI: string) {
        return this.sendTx(
            this.contract.updateOrganization(id, name, metadataURI).catch((e) => {
                throw new UpdateOrganizationError(e.message);
            }),
            async () => ({ success: true })
        );
    }

    addAdministrator(id: string, administrator: string) {
        return this.sendTx(
            this.contract.addAdministrator(id, administrator).catch((e) => {
                throw new AdministratorError(e.message);
            }),
            async () => ({ success: true })
        );
    }

    removeAdministrator(id: string, administrator: string) {
        return this.sendTx(
            this.contract.removeAdministrator(id, administrator).catch((e) => {
                throw new AdministratorError(e.message);
            }),
            async () => ({ success: true })
        );
    }

    deleteOrganization(id: string) {
        return this.sendTx(
            this.contract.deleteOrganization(id).catch((e) => {
                throw new DeleteOrganizationError(e.message);
            }),
            async () => ({ success: true })
        );
    }

    onOrganizationCreated(cb: OrganizationCreatedCallback): void {
        this.contract.on(
            this.contract.filters.OrganizationCreated(),
            this.normalizeListener<[string, string]>(cb)
        );
    }

    onOrganizationUpdated(cb: OrganizationUpdatedCallback): void {
        this.contract.on(
            this.contract.filters.OrganizationUpdated(),
            this.normalizeListener<[string, string]>(cb)
        );
    }

    removeAllListeners(): void {
        this.contract.removeAllListeners();
    }
}
