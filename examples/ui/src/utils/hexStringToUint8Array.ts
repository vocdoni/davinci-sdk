export const hexStringToUint8Array = (hex: string) =>
  new Uint8Array(
    hex
      .replace(/^0x/, '')
      .match(/.{1,2}/g)!
      .map((byte) => parseInt(byte, 16))
  )
