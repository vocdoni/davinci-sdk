import { buildBabyjub } from 'circomlibjs';

function getRandomBytes(n: number): Uint8Array {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    return globalThis.crypto.getRandomValues(new Uint8Array(n));
  }
  // Fallback for node if needed, or assume crypto is available
  // In node 19+, globalThis.crypto is available.
  // Otherwise could use 'crypto' module but trying to keep it browser compatible?
  // For now assuming environment has crypto.
  throw new Error('Crypto not available');
}

export interface ElGamal {
  babyjub: any;
  F: any;
  encrypt: (msg: bigint | string, pubKey: any, k: bigint | string) => { c1: any; c2: any };
  generateKeyPair: () => { privKey: bigint; pubKey: any };
  randomScalar: () => bigint;
  packPoint: (p: any) => any;
  unpackPoint: (p: any) => any;
  fromRTEtoTE: (xRTE: bigint | string, yRTE: bigint | string) => [any, any];
}

/**
 * Converts a point from Reduced TwistedEdwards (RTE) to TwistedEdwards (TE) coordinates.
 * Formula: x_TE = x_RTE / (-f), y_TE = y_RTE
 * where f = 6360561867910373094066688120553762416144456282423235903351243436111059670888
 */
function fromRTEtoTE(F: any, xRTE: bigint | string, yRTE: bigint | string): [any, any] {
  const scalingFactor = 6360561867910373094066688120553762416144456282423235903351243436111059670888n;
  
  // Convert to field elements
  const f = F.e(scalingFactor);
  const negF = F.neg(f); // -f mod p
  const negFInv = F.inv(negF); // (-f)^{-1} mod p
  
  const xRTEField = F.e(xRTE);
  const xTEField = F.mul(xRTEField, negFInv); // x_TE = x_RTE * (1 / (-f))
  
  const yTEField = F.e(yRTE); // y stays the same
  
  return [xTEField, yTEField];
}

export async function buildElGamal(): Promise<ElGamal> {
  const babyjub = await buildBabyjub();
  const F = babyjub.F;

  function randomScalar(): bigint {
    const bytes = getRandomBytes(32);
    let bi = 0n;
    for (let i = 0; i < bytes.length; i++) {
      bi += BigInt(bytes[i]) << BigInt(8 * i);
    }
    // Ensure it's in field. Subgroup order is usually used for private keys.
    // babyjub.order is the subgroup order.
    return bi % babyjub.order;
  }

  function generateKeyPair() {
    const privKey = randomScalar();
    const pubKey = babyjub.mulPointEscalar(babyjub.Base8, privKey);
    // Ensure pubKey coordinates are field elements
    return { privKey, pubKey: [F.e(pubKey[0]), F.e(pubKey[1])] };
  }

  function encrypt(msg: bigint | string, pubKey: any, k: bigint | string) {
    const kVal = BigInt(k);
    const mVal = BigInt(msg);

    // Ensure pubKey coordinates are field elements
    const pk = [F.e(pubKey[0]), F.e(pubKey[1])];

    // c1 = k * G
    const c1 = babyjub.mulPointEscalar(babyjub.Base8, kVal);

    // s = k * Pub
    const s = babyjub.mulPointEscalar(pk, kVal);

    // mPoint = m * G (Encoding message as point)
    const mPoint = babyjub.mulPointEscalar(babyjub.Base8, mVal);

    // c2 = mPoint + s
    const c2 = babyjub.addPoint(mPoint, s);

    return { c1, c2 };
  }

  return {
    babyjub,
    F,
    encrypt,
    generateKeyPair,
    randomScalar,
    packPoint: babyjub.packPoint,
    unpackPoint: babyjub.unpackPoint,
    fromRTEtoTE: (xRTE: bigint | string, yRTE: bigint | string) => fromRTEtoTE(F, xRTE, yRTE),
  };
}
