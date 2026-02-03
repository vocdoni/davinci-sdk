export function multiPoseidon(poseidon: any, F: any, inputs: bigint[]): bigint {
  if (inputs.length === 0) {
    throw new Error('multiPoseidon requires at least one input');
  }
  if (inputs.length <= 16) {
    return F.toObject(poseidon(inputs));
  }

  const hashes: bigint[] = [];
  for (let i = 0; i < inputs.length; i += 16) {
    const chunk = inputs.slice(i, i + 16);
    hashes.push(F.toObject(poseidon(chunk)));
  }

  return multiPoseidon(poseidon, F, hashes);
}
