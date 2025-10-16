import {
  OrganizationRegistry__factory,
  type OrganizationRegistry,
} from "@vocdoni/davinci-contracts";
import { SmartContractService } from "./SmartContractService";
import type { ContractRunner } from "ethers";
import {
  OrganizationCreateError,
  OrganizationUpdateError,
  OrganizationDeleteError,
  OrganizationAdministratorError,
} from "./errors";
import type {
  OrganizationCreatedCallback,
  OrganizationUpdatedCallback,
  OrganizationAdministratorAddedCallback,
  OrganizationAdministratorRemovedCallback,
} from "./types";

export interface OrganizationInfo {
  name: string;
  metadataURI: string;
}

export class OrganizationRegistryService extends SmartContractService {
  private contract: OrganizationRegistry;

  constructor(contractAddress: string, runner: ContractRunner) {
    super();
    this.contract = OrganizationRegistry__factory.connect(
      contractAddress,
      runner,
    );
  }

  // ─── READ OPERATIONS ───────────────────────────────────────────────────────

  async getOrganization(id: string): Promise<OrganizationInfo> {
    const { name, metadataURI } = await this.contract.getOrganization(id);
    return { name, metadataURI };
  }

  async existsOrganization(id: string): Promise<boolean> {
    return this.contract.exists(id);
  }  

  async isAdministrator(id: string, address: string): Promise<boolean> {
    return this.contract.isAdministrator(id, address);
  }

  async getOrganizationCount(): Promise<number> {
    const count = await this.contract.organizationCount();
    return Number(count);
  }

  // ─── WRITE OPERATIONS ──────────────────────────────────────────────────────

  createOrganization(
    name: string,
    metadataURI: string,
    administrators: string[],
  ) {
    return this.sendTx(
      this.contract
        .createOrganization(name, metadataURI, administrators)
        .catch((e) => {
          throw new OrganizationCreateError(e.message, 'create');
        }),
      async () => ({ success: true }),
    );
  }

  updateOrganization(
    id: string,
    name: string,
    metadataURI: string,
  ) {
    return this.sendTx(
      this.contract
        .updateOrganization(id, name, metadataURI)
        .catch((e) => {
          throw new OrganizationUpdateError(e.message, 'update');
        }),
      async () => ({ success: true }),
    );
  }

  addAdministrator(id: string, administrator: string) {
    return this.sendTx(
      this.contract
        .addAdministrator(id, administrator)
        .catch((e) => {
          throw new OrganizationAdministratorError(e.message, 'addAdministrator');
        }),
      async () => ({ success: true }),
    );
  }

  removeAdministrator(id: string, administrator: string) {
    return this.sendTx(
      this.contract
        .removeAdministrator(id, administrator)
        .catch((e) => {
          throw new OrganizationAdministratorError(e.message, 'removeAdministrator');
        }),
      async () => ({ success: true }),
    );
  }

  deleteOrganization(id: string) {
    return this.sendTx(
      this.contract
        .deleteOrganization(id)
        .catch((e) => {
          throw new OrganizationDeleteError(e.message, 'delete');
        }),
      async () => ({ success: true }),
    );
  }

  // ─── EVENT LISTENERS ───────────────────────────────────────────────────────

  onOrganizationCreated(cb: OrganizationCreatedCallback): void {
    this.setupEventListener<[string]>(
      this.contract,
      this.contract.filters.OrganizationCreated(),
      cb
    ).catch(err => console.error('Error setting up OrganizationCreated listener:', err));
  }

  onOrganizationUpdated(cb: OrganizationUpdatedCallback): void {
    this.setupEventListener<[string, string]>(
      this.contract,
      this.contract.filters.OrganizationUpdated(),
      cb
    ).catch(err => console.error('Error setting up OrganizationUpdated listener:', err));
  }

  onAdministratorAdded(cb: OrganizationAdministratorAddedCallback): void {
    this.setupEventListener<[string, string]>(
      this.contract,
      this.contract.filters.AdministratorAdded(),
      cb
    ).catch(err => console.error('Error setting up AdministratorAdded listener:', err));
  }

  onAdministratorRemoved(cb: OrganizationAdministratorRemovedCallback): void {
    this.setupEventListener<[string, string, string]>(
      this.contract,
      this.contract.filters.AdministratorRemoved(),
      cb
    ).catch(err => console.error('Error setting up AdministratorRemoved listener:', err));
  }

  removeAllListeners(): void {
    this.contract.removeAllListeners();
    this.clearPollingIntervals();
  }
}
