declare module 'circomlibjs' {
  export interface BabyJub {
    F: any;
    p: bigint;
    pm1d2: bigint;
    Generator: any;
    Base8: any;
    order: bigint;
    subOrder: bigint;
    A: bigint;
    D: bigint;
    mulPointEscalar: (point: any, scalar: bigint | string) => any;
    addPoint: (p1: any, p2: any) => any;
    packPoint: (point: any) => any;
    unpackPoint: (packed: any) => any;
  }

  export function buildBabyjub(): Promise<BabyJub>;

  export function buildPoseidon(): Promise<{
    (inputs: (bigint | number)[]): any;
    F: any;
  }>;

  export function buildMimc7(): Promise<any>;
  export function buildPedersenHash(): Promise<any>;
  export function buildMimcSponge(): Promise<any>;
  export function buildEddsa(): Promise<any>;
}
