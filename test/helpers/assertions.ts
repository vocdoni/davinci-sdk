export function expectHex(value: string, bytes?: number): void {
  const pattern = bytes
    ? new RegExp(`^0x[a-fA-F0-9]{${bytes * 2}}$`)
    : /^0x[a-fA-F0-9]+$/;

  expect(value).toMatch(pattern);
}

export function expectAddress(value: string): void {
  expect(value).toMatch(/^0x[a-fA-F0-9]{40}$/);
}
