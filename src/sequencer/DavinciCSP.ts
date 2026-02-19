import { buildBabyjub, buildEddsa, buildPoseidon } from 'circomlibjs';
import { CensusOrigin } from '../census/types';

export type HexBytes = Uint8Array;
export type ProcessID = Uint8Array;
export type HexString = string;

export interface CSPSignOutput {
  censusOrigin: CensusOrigin;
  root: HexString;
  address: HexString;
  weight: string;
  processId: HexString;
  publicKey: HexString;
  signature: HexString;
}

// Kept for backward compatibility with previous constructor signature.
export interface DavinciCSPOptions {
  wasmExecUrl?: string;
  wasmUrl?: string;
  initTimeoutMs?: number;
  wasmExecHash?: string;
  wasmHash?: string;
}

interface InternalCensusProof {
  censusOrigin: number;
  root: HexString;
  address: HexString;
  weight: bigint;
  processId: HexString;
  publicKey: HexString;
  signature: HexString;
}

const CENSUS_ROOT_LENGTH = 32;
const SPONGE_CHUNK_SIZE = 31;
const DEFAULT_FRAME_SIZE = 6;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type Poseidon = Awaited<ReturnType<typeof buildPoseidon>>;
type Eddsa = Awaited<ReturnType<typeof buildEddsa>>;
type Babyjub = Awaited<ReturnType<typeof buildBabyjub>>;

export class DavinciCSP {
  private initialized = false;
  private poseidon!: Poseidon;
  private eddsa!: Eddsa;
  private babyjub!: Babyjub;

  constructor(_opts?: DavinciCSPOptions) {
    // No-op. We keep this constructor for API compatibility.
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    const [poseidon, eddsa, babyjub] = await Promise.all([
      buildPoseidon(),
      buildEddsa(),
      buildBabyjub(),
    ]);

    this.poseidon = poseidon;
    this.eddsa = eddsa;
    this.babyjub = babyjub;
    this.initialized = true;
  }

  async cspSign(
    censusOrigin: CensusOrigin,
    privKey: string,
    processId: string,
    address: string,
    weight: string
  ): Promise<CSPSignOutput> {
    this.ensureInitialized();
    this.assertCSPOrigin(censusOrigin);

    const weightValue = parsePositiveBigInt(weight, 'weight');
    const secret = this.seedToPrivateKey(hexToBytes(privKey));
    const processIdBytes = hexToBytes(processId);
    const addressBytes = hexToBytes(address);

    const proof = this.generateProof(secret, processIdBytes, addressBytes, weightValue);

    return {
      censusOrigin: CensusOrigin.CSP,
      root: proof.root,
      address: proof.address,
      weight: proof.weight.toString(),
      processId: proof.processId,
      publicKey: proof.publicKey,
      signature: proof.signature,
    };
  }

  async cspVerify(
    censusOrigin: CensusOrigin,
    root: string,
    address: string,
    weight: string,
    processId: string,
    publicKey: string,
    signature: string
  ): Promise<boolean> {
    this.ensureInitialized();
    this.assertCSPOrigin(censusOrigin);

    const proof: InternalCensusProof = {
      censusOrigin,
      root,
      address,
      weight: parsePositiveBigInt(weight, 'weight'),
      processId,
      publicKey,
      signature,
    };

    try {
      this.verifyProof(proof);
      return true;
    } catch {
      return false;
    }
  }

  async cspCensusRoot(censusOrigin: CensusOrigin, privKey: string): Promise<string> {
    this.ensureInitialized();
    this.assertCSPOrigin(censusOrigin);

    const secret = this.seedToPrivateKey(hexToBytes(privKey));
    const pubKey = this.eddsa.prv2pub(secret);
    const [x, y] = pointToBigInts(this.babyjub, pubKey);
    const root = poseidonToBigInt(this.poseidon, [x, y]);

    return bytesToHexPrefixed(leftPad(bigIntToBytes(root), CENSUS_ROOT_LENGTH));
  }

  private generateProof(
    privKey: Uint8Array,
    processId: ProcessID,
    address: HexBytes,
    weight: bigint
  ): InternalCensusProof {
    if (processId.length === 0) {
      throw new Error('invalid process ID');
    }
    if (address.length === 0) {
      throw new Error('invalid address');
    }
    if (weight <= 0n) {
      throw new Error('invalid weight');
    }

    const message = signatureMessage(this.poseidon, processId, address, weight);
    const messageField = this.babyjub.F.e(message);
    const signature = this.eddsa.signPoseidon(privKey, messageField);
    const packedSignature = this.eddsa.packSignature(signature);
    const marshaledSignature = textEncoder.encode(bytesToHex(packedSignature));
    const encSignature = encodeBytes(marshaledSignature);

    const pubKey = this.eddsa.prv2pub(privKey);
    const packedPublicKey = this.babyjub.packPoint(pubKey);
    const marshaledPubKey = textEncoder.encode(bytesToHex(packedPublicKey));
    const encPublicKey = encodeBytes(marshaledPubKey);

    const [x, y] = pointToBigInts(this.babyjub, pubKey);
    const root = poseidonToBigInt(this.poseidon, [x, y]);

    return {
      censusOrigin: CensusOrigin.CSP,
      root: bytesToHexPrefixed(leftPad(bigIntToBytes(root), CENSUS_ROOT_LENGTH)),
      address: bytesToHexPrefixed(address),
      weight,
      processId: bytesToHexPrefixed(processId),
      publicKey: bytesToHexPrefixed(encPublicKey),
      signature: bytesToHexPrefixed(encSignature),
    };
  }

  private verifyProof(proof: InternalCensusProof): void {
    if (!proof) {
      throw new Error('proof is nil');
    }

    if (proof.censusOrigin !== CensusOrigin.CSP) {
      throw new Error(`proof origin mismatch: expected ${CensusOrigin.CSP}, got ${proof.censusOrigin}`);
    }

    const pubKey = publicKeyFromBytes(this.babyjub, proof.publicKey);
    const processId = hexToBytes(proof.processId);
    const address = hexToBytes(proof.address);
    const message = signatureMessage(this.poseidon, processId, address, proof.weight);
    const messageField = this.babyjub.F.e(message);

    const signatureBytes = decodeBytes(hexToBytes(proof.signature));
    const packedSignature = hexToBytes(textDecoder.decode(signatureBytes));
    const signature = this.eddsa.unpackSignature(packedSignature);

    const verified = this.eddsa.verifyPoseidon(messageField, signature, pubKey);
    if (!verified) {
      throw new Error('signature verification failed');
    }

    const [x, y] = pointToBigInts(this.babyjub, pubKey);
    const computedRoot = bytesToHexPrefixed(
      leftPad(bigIntToBytes(poseidonToBigInt(this.poseidon, [x, y])), CENSUS_ROOT_LENGTH)
    );

    if (normalizeHex(computedRoot) !== normalizeHex(proof.root)) {
      throw new Error('root mismatch');
    }
  }

  private seedToPrivateKey(seed: Uint8Array): Uint8Array {
    if (seed.length === 0) {
      throw new Error('seed cannot be empty');
    }

    const hashed = poseidonHashBytes(this.poseidon, seed, DEFAULT_FRAME_SIZE);
    return toFixedLength(bigIntToBytes(hashed, 32), 32);
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('DavinciCSP not initialized — call `await init()` first');
    }
  }

  private assertCSPOrigin(censusOrigin: CensusOrigin): void {
    if (censusOrigin !== CensusOrigin.CSP) {
      throw new Error(`Invalid census origin for CSP operations: ${censusOrigin}`);
    }
  }
}

function signatureMessage(
  poseidon: Poseidon,
  processId: Uint8Array,
  address: Uint8Array,
  weight: bigint
): bigint {
  const processIdValue = bytesToBigInt(processId);
  const addressValue = bytesToBigInt(address);
  return poseidonToBigInt(poseidon, [processIdValue, addressValue, weight]);
}

function publicKeyFromBytes(
  babyjub: Babyjub,
  publicKey: HexString
): ReturnType<Babyjub['unpackPoint']> {
  if (!publicKey) {
    throw new Error('public key bytes are empty');
  }

  const encodedBytes = hexToBytes(publicKey);
  const marshaledBytes = decodeBytes(encodedBytes);
  const packed = hexToBytes(textDecoder.decode(marshaledBytes));
  return babyjub.unpackPoint(packed);
}

function poseidonHashBytes(poseidon: Poseidon, message: Uint8Array, frameSize: number): bigint {
  if (frameSize < 2 || frameSize > 16) {
    throw new Error('incorrect frame size');
  }

  const inputs = Array.from({ length: frameSize }, () => 0n);
  let dirty = false;
  let hash = 0n;
  let k = 0;

  for (let i = 0; i < Math.floor(message.length / SPONGE_CHUNK_SIZE); i += 1) {
    dirty = true;
    const start = SPONGE_CHUNK_SIZE * i;
    inputs[k] = bytesToBigInt(message.slice(start, start + SPONGE_CHUNK_SIZE));

    if (k === frameSize - 1) {
      hash = poseidonToBigInt(poseidon, inputs);
      dirty = false;
      inputs.fill(0n);
      inputs[0] = hash;
      k = 1;
    } else {
      k += 1;
    }
  }

  if (message.length % SPONGE_CHUNK_SIZE !== 0) {
    const buf = new Uint8Array(SPONGE_CHUNK_SIZE);
    buf.set(message.slice(Math.floor(message.length / SPONGE_CHUNK_SIZE) * SPONGE_CHUNK_SIZE));
    inputs[k] = bytesToBigInt(buf);
    dirty = true;
  }

  if (dirty) {
    hash = poseidonToBigInt(poseidon, inputs);
  }

  return hash;
}

function poseidonToBigInt(poseidon: Poseidon, inputs: bigint[]): bigint {
  if (!poseidon.F) {
    throw new Error('poseidon field is missing');
  }

  const fieldInputs = inputs.map((value) => poseidon.F.e(value));
  const result = poseidon(fieldInputs);
  return poseidon.F.toObject(result);
}

function pointToBigInts(babyjub: Babyjub, point: unknown): [bigint, bigint] {
  if (!babyjub.F) {
    throw new Error('babyjub field is missing');
  }

  if (Array.isArray(point) && point.length >= 2) {
    return [coerceField(babyjub, point[0]), coerceField(babyjub, point[1])];
  }

  throw new Error('unexpected public key format');
}

function coerceField(babyjub: Babyjub, value: unknown): bigint {
  if (typeof value === 'bigint') {
    return value;
  }

  if (!babyjub.F) {
    throw new Error('babyjub field is missing');
  }

  return babyjub.F.toObject(value);
}

function parsePositiveBigInt(value: string, fieldName: string): bigint {
  if (!value || value.trim() === '') {
    throw new Error(`invalid ${fieldName}`);
  }

  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`invalid ${fieldName}`);
  }

  if (parsed <= 0n) {
    throw new Error(`invalid ${fieldName}`);
  }

  return parsed;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) + BigInt(byte);
  }
  return value;
}

function bigIntToBytes(value: bigint, minLength = 0): Uint8Array {
  if (value === 0n) {
    return minLength > 0 ? new Uint8Array(minLength) : new Uint8Array([0]);
  }

  let v = value;
  const out: number[] = [];
  while (v > 0n) {
    out.push(Number(v & 0xffn));
    v >>= 8n;
  }

  out.reverse();
  return leftPad(Uint8Array.from(out), minLength);
}

function leftPad(bytes: Uint8Array, length: number): Uint8Array {
  if (bytes.length >= length) {
    return bytes;
  }

  const out = new Uint8Array(length);
  out.set(bytes, length - bytes.length);
  return out;
}

function toFixedLength(bytes: Uint8Array, length: number): Uint8Array {
  if (bytes.length === length) {
    return bytes;
  }

  if (bytes.length > length) {
    return bytes.slice(bytes.length - length);
  }

  return leftPad(bytes, length);
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

function bytesToHexPrefixed(bytes: Uint8Array): string {
  return `0x${bytesToHex(bytes)}`;
}

function normalizeHex(value: string): string {
  return value.toLowerCase().replace(/^0x/, '');
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (normalized.length % 2 !== 0) {
    throw new Error('invalid hex string length');
  }

  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }

  return out;
}

function encodeBytes(rawBytes: Uint8Array): Uint8Array {
  if (rawBytes.length === 0) {
    throw new Error('bytes provided are empty');
  }

  const hexText = bytesToHex(rawBytes);
  const value = BigInt(hexText);
  return bigIntToBytes(value);
}

function decodeBytes(encodedBytes: Uint8Array): Uint8Array {
  if (encodedBytes.length === 0) {
    throw new Error('bytes provided are empty');
  }

  const value = bytesToBigInt(encodedBytes);
  const encodedHexText = value.toString(10);
  if (encodedHexText.length % 2 !== 0) {
    throw new Error(`encoded bytes has odd length: ${encodedHexText.length}`);
  }

  return hexToBytes(encodedHexText);
}
