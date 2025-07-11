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
    this.contract.on(
      this.contract.filters.OrganizationCreated(),
      this.normalizeListener<[string]>(cb),
    );
  }

  onOrganizationUpdated(cb: OrganizationUpdatedCallback): void {
    this.contract.on(
      this.contract.filters.OrganizationUpdated(),
      this.normalizeListener<[string, string]>(cb),
    );
  }

  onAdministratorAdded(cb: OrganizationAdministratorAddedCallback): void {
    this.contract.on(
      this.contract.filters.AdministratorAdded(),
      this.normalizeListener<[string, string]>(cb)
    );
  }

  onAdministratorRemoved(cb: OrganizationAdministratorRemovedCallback): void {
    this.contract.on(
      this.contract.filters.AdministratorRemoved(),
      this.normalizeListener<[string, string, string]>(cb)
    );
  }

  removeAllListeners(): void {
    this.contract.removeAllListeners();
  }
}
