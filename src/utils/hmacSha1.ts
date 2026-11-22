/**
 * 纯 JS 的 SHA1 / HMAC-SHA1（用于 ACRCloud 签名）
 */
const sha1 = (data: Uint8Array): Uint8Array => {
  const bitLen = data.length * 8
  const totalLen = Math.ceil((data.length + 9) / 64) * 64
  const buffer = new Uint8Array(totalLen)
  buffer.set(data)
  buffer[data.length] = 0x80
  const view = new DataView(buffer.buffer)
  view.setUint32(totalLen - 8, Math.floor(bitLen / 4294967296))
  view.setUint32(totalLen - 4, bitLen >>> 0)

  let h0 = 0x67452301
  let h1 = 0xEFCDAB89
  let h2 = 0x98BADCFE
  let h3 = 0x10325476
  let h4 = 0xC3D2E1F0
  const w = new Uint32Array(80)

  for (let i = 0; i < totalLen; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = view.getUint32(i + j * 4)
    for (let j = 16; j < 80; j++) {
      const n = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16]
      w[j] = (n << 1) | (n >>> 31)
    }
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let j = 0; j < 80; j++) {
      let f: number
      let k: number
      if (j < 20) {
        f = (b & c) | ((~b) & d)
        k = 0x5A827999
      } else if (j < 40) {
        f = b ^ c ^ d
        k = 0x6ED9EBA1
      } else if (j < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8F1BBCDC
      } else {
        f = b ^ c ^ d
        k = 0xCA62C1D6
      }
      const t = ((((a << 5) | (a >>> 27)) >>> 0) + (f >>> 0) + e + k + w[j]) >>> 0
      e = d
      d = c
      c = ((b << 30) | (b >>> 2)) >>> 0
      b = a
      a = t
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }

  const out = new Uint8Array(20)
  const outView = new DataView(out.buffer)
  outView.setUint32(0, h0)
  outView.setUint32(4, h1)
  outView.setUint32(8, h2)
  outView.setUint32(12, h3)
  outView.setUint32(16, h4)
  return out
}

const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

export const hmacSha1 = (key: Uint8Array, message: Uint8Array): Uint8Array => {
  const blockSize = 64
  const normalizedKey = key.length > blockSize ? sha1(key) : key
  const keyPad = new Uint8Array(blockSize)
  keyPad.set(normalizedKey)
  const innerPad = new Uint8Array(blockSize)
  const outerPad = new Uint8Array(blockSize)
  for (let i = 0; i < blockSize; i++) {
    innerPad[i] = keyPad[i] ^ 0x36
    outerPad[i] = keyPad[i] ^ 0x5c
  }
  return sha1(concat(outerPad, sha1(concat(innerPad, message))))
}
