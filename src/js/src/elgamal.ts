import { buildBabyjub } from 'circomlibjs';

function getRandomBytes(n: number): Uint8Array {
    if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
        return globalThis.crypto.getRandomValues(new Uint8Array(n));
    }
    // Fallback for node if needed, or assume crypto is available
    // In node 19+, globalThis.crypto is available.
    // Otherwise could use 'crypto' module but trying to keep it browser compatible?
    // For now assuming environment has crypto.
    throw new Error("Crypto not available");
}

export interface ElGamal {
    babyjub: any;
    F: any;
    encrypt: (msg: bigint | string, pubKey: any, k: bigint | string) => { c1: any, c2: any };
    generateKeyPair: () => { privKey: bigint, pubKey: any };
    randomScalar: () => bigint;
    packPoint: (p: any) => any;
    unpackPoint: (p: any) => any;
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
        return { privKey, pubKey };
    }

    function encrypt(msg: bigint | string, pubKey: any, k: bigint | string) {
        const kVal = BigInt(k);
        const mVal = BigInt(msg);

        // c1 = k * G
        const c1 = babyjub.mulPointEscalar(babyjub.Base8, kVal);

        // s = k * Pub
        const s = babyjub.mulPointEscalar(pubKey, kVal);

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
        unpackPoint: babyjub.unpackPoint
    };
}