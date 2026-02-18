export async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitFor(
  predicate: () => Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const intervalMs = options.intervalMs ?? 2_000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }

    await sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for condition${options.label ? `: ${options.label}` : ''}`);
}
