import { FIELD_MODULUS } from './constants';

export { FIELD_MODULUS };

export function mod(n: bigint, m: bigint = FIELD_MODULUS): bigint {
  const res = n % m;
  return res >= 0n ? res : res + m;
}
