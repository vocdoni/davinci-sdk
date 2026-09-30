import { getAddress, type Signer } from 'ethers';
import { type CspAttestation, signCspAttestation } from '../crypto/ecdsa';
import { CENSUS_WEIGHT_BITS } from '../protocol/limits';
import { normalizeProcessId } from '../sequencer/api/helpers';
import { CspCensus } from './classes/CspCensus';
import { CensusError } from './errors';
import type { CspCensusWitness } from './types';

/** What a CSP attests for one voter. */
export interface CspAttestRequest {
  /** Process id, `0x` + 62 hex digits. */
  processId: string;
  /** The voter's address. */
  address: string;
  /**
   * The voter's weight, below 2^88. Default: the weight this signer gave the
   * address before in this process, else 1.
   */
  weight?: bigint;
  /**
   * The voter's index; its ballot slot is `0x10 + index`. Default: the index
   * this signer gave the address before in this process, else the next free one.
   */
  index?: bigint;
}

/** What a voter holds in one process. */
interface Credential {
  index: bigint;
  weight: bigint;
}

interface ProcessIndexes {
  byAddress: Map<string, Credential>;
  byIndex: Map<bigint, string>;
  next: bigint;
}

const MAX_INDEX = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * The CSP side of a CSP census (origin 4): signs each voter's attestation
 * with the CSP's secp256k1 key, whose address is the census root.
 *
 * A voter's ballot slot is `0x10 + index`, so every voter needs an index of
 * its own, and only one: two voters on one index overwrite each other's
 * ballots, and a voter with two indexes votes twice. Without an explicit
 * index the signer hands out 0, 1, 2… per process and gives an address the
 * same index again; it refuses an explicit index that breaks either rule.
 * The weight is pinned the same way: once a voter is attested with a weight
 * in a process, a request for another weight is refused, since any of the
 * attestations would let the voter vote with its weight.
 *
 * That memory lasts as long as the instance: a CSP that restarts keeps its
 * own table of address, index and weight, and passes both. Indexes stay at
 * or below 2^53 - 1, since the vote carries them as JSON numbers.
 *
 * @example
 * ```typescript
 * const csp = new CspSigner(cspWallet);
 * const census = await csp.census('https://csp.example.org');
 * // later, for an authenticated voter:
 * const attestation = await csp.attest({ processId, address: voter });
 * ```
 */
export class CspSigner {
  private readonly processes = new Map<string, ProcessIndexes>();

  /** @param signer - The CSP's key */
  constructor(readonly signer: Signer) {}

  /** The CSP's address: the census root. */
  async address(): Promise<string> {
    return getAddress(await this.signer.getAddress());
  }

  /** The census of this CSP, with `uri` telling voters where it is. */
  census(uri: string): Promise<CspCensus> {
    return CspCensus.fromSigner(this.signer, uri);
  }

  /** The index this signer gave `address` in `processId`, if any. */
  indexOf(processId: string, address: string): bigint | undefined {
    return this.credential(processId, address)?.index;
  }

  /** The weight this signer attested for `address` in `processId`, if any. */
  weightOf(processId: string, address: string): bigint | undefined {
    return this.credential(processId, address)?.weight;
  }

  private credential(processId: string, address: string): Credential | undefined {
    return this.processes.get(normalizeProcessId(processId))?.byAddress.get(getAddress(address));
  }

  /**
   * Signs the attestation that `address` may vote with `weight` in slot
   * `0x10 + index`. The signature is low-S and recovers to this CSP.
   *
   * @throws CensusError for an index another voter holds, or a second index
   *   or weight for a voter
   * @throws RangeError for a weight of 2^88 or more
   */
  async attest(request: CspAttestRequest): Promise<CspAttestation> {
    const processId = normalizeProcessId(request.processId);
    const address = getAddress(request.address);
    const { index, weight } = this.reserve(processId, address, request.index, request.weight);
    return signCspAttestation(this.signer, { processId, address, weight, index });
  }

  /** {@link attest} as the witness a voter votes with. */
  async witness(request: CspAttestRequest): Promise<CspCensusWitness> {
    return { type: 'csp', attestation: await this.attest(request) };
  }

  // The voter's index and weight, recorded before signing so concurrent
  // calls never share an index nor split a voter.
  private reserve(
    processId: string,
    address: string,
    wantedIndex?: bigint,
    wantedWeight?: bigint
  ): Credential {
    let p = this.processes.get(processId);
    if (!p) {
      p = { byAddress: new Map(), byIndex: new Map(), next: 0n };
      this.processes.set(processId, p);
    }
    const held = p.byAddress.get(address);
    const weight = wantedWeight ?? held?.weight ?? 1n;
    if (weight < 0n || weight >> BigInt(CENSUS_WEIGHT_BITS) !== 0n) {
      throw new RangeError(`weight does not fit in ${CENSUS_WEIGHT_BITS} bits`);
    }
    if (held !== undefined && held.weight !== weight) {
      throw new CensusError(`${address} already has weight ${held.weight} in ${processId}`);
    }
    let index = wantedIndex;
    if (index === undefined) {
      if (held !== undefined) return held;
      while (p.byIndex.has(p.next)) p.next++;
      index = p.next;
    }
    if (index < 0n || index > MAX_INDEX) {
      throw new CensusError(`CSP index ${index} is outside [0, 2^53 - 1]`);
    }
    if (held !== undefined && held.index !== index) {
      throw new CensusError(`${address} already has index ${held.index} in ${processId}`);
    }
    const owner = p.byIndex.get(index);
    if (owner !== undefined && owner !== address) {
      throw new CensusError(`index ${index} already belongs to ${owner} in ${processId}`);
    }
    const credential = { index, weight };
    p.byAddress.set(address, credential);
    p.byIndex.set(index, address);
    return credential;
  }
}
