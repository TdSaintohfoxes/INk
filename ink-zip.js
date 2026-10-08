/* INK — lazy ZIP reader.
 *
 * Only the central directory is read up front. Each entry is read from the
 * Blob (via slice) and inflated when somebody asks for it, so a 2 GB comic
 * archive never sits in memory. Uses DecompressionStream where available and
 * falls back to a small built-in inflate otherwise.
 */

const u16 = (d, o) => d.getUint16(o, true);
const u32 = (d, o) => d.getUint32(o, true);
const u64 = (d, o) => Number(d.getBigUint64(o, true));

function decodeName(bytes, utf8Flag) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { /* not UTF-8: fall through */ }
  return new TextDecoder(utf8Flag ? 'utf-8' : 'windows-1252').decode(bytes);
}

export class ZipError extends Error {
  constructor(msg, code) { super(msg); this.code = code || 'zip'; }
}

export async function openZip(blob) {
  const size = blob.size;
  if (size < 22) throw new ZipError('File is too small to be a ZIP archive', 'corrupt');

  // 1. End of central directory (scan the last 64 KB)
  const tailLen = Math.min(size, 65557);
  const tail = new DataView(await blob.slice(size - tailLen, size).arrayBuffer());
  let e = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) { e = i; break; }
  }
  if (e < 0) throw new ZipError('Not a valid ZIP archive (no directory found)', 'corrupt');
  let total = u16(tail, e + 10);
  let cdSize = u32(tail, e + 12);
  let cdOff = u32(tail, e + 16);

  // zip64
  if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    const locPos = e - 20;
    if (locPos >= 0 && tail.getUint32(locPos, true) === 0x07064b50) {
      const z64Off = u64(tail, locPos + 8);
      const z = new DataView(await blob.slice(z64Off, z64Off + 56).arrayBuffer());
      if (u32(z, 0) === 0x06064b50) {
        total = u64(z, 32);
        cdSize = u64(z, 40);
        cdOff = u64(z, 48);
      }
    } else if (locPos < 0) {
      // locator lies before our tail window – read it explicitly
      const b = new DataView(await blob.slice(size - tailLen - 20 + e, size - tailLen + e).arrayBuffer().catch(() => new ArrayBuffer(0)));
      if (b.byteLength >= 20 && b.getUint32(0, true) === 0x07064b50) {
        const z64Off = u64(b, 8);
        const z = new DataView(await blob.slice(z64Off, z64Off + 56).arrayBuffer());
        if (u32(z, 0) === 0x06064b50) { total = u64(z, 32); cdSize = u64(z, 40); cdOff = u64(z, 48); }
      }
    }
  }

  // 2. Central directory
  const cdBuf = await blob.slice(cdOff, cdOff + cdSize).arrayBuffer();
  const cd = new DataView(cdBuf);
  const cdBytes = new Uint8Array(cdBuf);
  const entries = [];
  let p = 0;
  while (p + 46 <= cdBuf.byteLength && u32(cd, p) === 0x02014b50) {
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    let csize = u32(cd, p + 20);
    let usize = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    let off = u32(cd, p + 42);
    const name = decodeName(cdBytes.subarray(p + 46, p + 46 + nameLen), !!(flags & 0x800)).replace(/\\/g, '/');
    // zip64 extra
    if (csize === 0xffffffff || usize === 0xffffffff || off === 0xffffffff) {
      let x = p + 46 + nameLen;
      const xend = x + extraLen;
      while (x + 4 <= xend) {
        const id = u16(cd, x), len = u16(cd, x + 2);
        if (id === 0x0001) {
          let q = x + 4;
          if (usize === 0xffffffff) { usize = u64(cd, q); q += 8; }
          if (csize === 0xffffffff) { csize = u64(cd, q); q += 8; }
          if (off === 0xffffffff) { off = u64(cd, q); q += 8; }
          break;
        }
        x += 4 + len;
      }
    }
    entries.push({ name, size: usize, csize, method, offset: off, encrypted: !!(flags & 1), isDir: name.endsWith('/') });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const byName = new Map();
  const byLower = new Map();
  for (const en of entries) {
    byName.set(en.name, en);
    byLower.set(en.name.toLowerCase(), en);
  }

  function find(path) {
    if (!path) return null;
    path = String(path).replace(/^\/+/, '');
    return byName.get(path)
      || byLower.get(path.toLowerCase())
      || (() => { try { const d = decodeURIComponent(path); return byName.get(d) || byLower.get(d.toLowerCase()); } catch { return null; } })()
      || null;
  }

  async function read(entry) {
    if (typeof entry === 'string') {
      const f = find(entry);
      if (!f) throw new ZipError('Missing file in archive: ' + entry, 'missing');
      entry = f;
    }
    if (entry.encrypted) throw new ZipError('This archive is password protected', 'encrypted');
    const head = new DataView(await blob.slice(entry.offset, entry.offset + 30).arrayBuffer());
    if (head.byteLength < 30 || u32(head, 0) !== 0x04034b50) throw new ZipError('Corrupted archive entry: ' + entry.name, 'corrupt');
    const start = entry.offset + 30 + u16(head, 26) + u16(head, 28);
    const part = blob.slice(start, start + entry.csize);
    if (entry.method === 0) return new Uint8Array(await part.arrayBuffer());
    if (entry.method !== 8) throw new ZipError('Unsupported compression method ' + entry.method, 'unsupported');
    if (typeof DecompressionStream !== 'undefined' && !openZip.forceFallback) {
      try {
        const out = await new Response(part.stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
        return new Uint8Array(out);
      } catch { /* fall back below */ }
    }
    return inflateRaw(new Uint8Array(await part.arrayBuffer()), entry.size);
  }

  return {
    entries,
    find,
    has: (p) => !!find(p),
    read,
    async text(entry) { return new TextDecoder('utf-8').decode(await read(entry)); },
    async blob(entry, type) {
      const en = typeof entry === 'string' ? find(entry) : entry;
      if (en && en.method === 0 && !en.encrypted) {
        // stored: slice without copying
        const head = new DataView(await blob.slice(en.offset, en.offset + 30).arrayBuffer());
        const start = en.offset + 30 + u16(head, 26) + u16(head, 28);
        return blob.slice(start, start + en.csize, type || '');
      }
      return new Blob([await read(entry)], { type: type || '' });
    },
  };
}

/* ---------- compact inflate (RFC 1951), used only when DecompressionStream is unavailable ---------- */
const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function huff(lengths, n) {
  const count = new Uint16Array(16), symbol = new Uint16Array(n), offs = new Uint16Array(16);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  for (let l = 1; l < 15; l++) offs[l + 1] = offs[l] + count[l];
  for (let s = 0; s < n; s++) if (lengths[s]) symbol[offs[lengths[s]]++] = s;
  return { count, symbol };
}

export function inflateRaw(src, sizeHint) {
  let pos = 0, buf = 0, cnt = 0;
  let out = new Uint8Array(Math.max(sizeHint || 0, src.length * 3, 1024)), op = 0;
  const bits = (n) => {
    if (!n) return 0;
    while (cnt < n) {
      if (pos >= src.length) throw new ZipError('Unexpected end of compressed data', 'corrupt');
      buf |= src[pos++] << cnt; cnt += 8;
    }
    const v = buf & ((1 << n) - 1);
    buf >>>= n; cnt -= n;
    return v;
  };
  const decode = (hf) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= bits(1);
      const c = hf.count[len];
      if (code - c < first) return hf.symbol[index + (code - first)];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new ZipError('Bad compressed data', 'corrupt');
  };
  const ensure = (n) => {
    if (op + n <= out.length) return;
    const bigger = new Uint8Array(Math.max(out.length * 2, op + n));
    bigger.set(out); out = bigger;
  };
  let fixedL, fixedD;
  let last;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      buf = 0; cnt = 0;
      const len = src[pos] | (src[pos + 1] << 8);
      pos += 4;
      ensure(len);
      out.set(src.subarray(pos, pos + len), op);
      op += len; pos += len;
      continue;
    }
    let lit, dist;
    if (type === 1) {
      if (!fixedL) {
        const l = new Uint8Array(288);
        for (let i = 0; i < 144; i++) l[i] = 8;
        for (let i = 144; i < 256; i++) l[i] = 9;
        for (let i = 256; i < 280; i++) l[i] = 7;
        for (let i = 280; i < 288; i++) l[i] = 8;
        fixedL = huff(l, 288);
        fixedD = huff(new Uint8Array(30).fill(5), 30);
      }
      lit = fixedL; dist = fixedD;
    } else if (type === 2) {
      const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < ncode; i++) cl[CLORDER[i]] = bits(3);
      const clh = huff(cl, 19);
      const lens = new Uint8Array(nlen + ndist);
      let i = 0;
      while (i < nlen + ndist) {
        const sym = decode(clh);
        if (sym < 16) lens[i++] = sym;
        else {
          let prev = 0, rep;
          if (sym === 16) { prev = lens[i - 1]; rep = 3 + bits(2); }
          else if (sym === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          while (rep--) lens[i++] = prev;
        }
      }
      lit = huff(lens.subarray(0, nlen), nlen);
      dist = huff(lens.subarray(nlen), ndist);
    } else throw new ZipError('Bad compressed block', 'corrupt');

    for (;;) {
      let sym = decode(lit);
      if (sym < 256) { ensure(1); out[op++] = sym; }
      else if (sym === 256) break;
      else {
        sym -= 257;
        const len = LBASE[sym] + bits(LEXT[sym]);
        const ds = decode(dist);
        const d = DBASE[ds] + bits(DEXT[ds]);
        ensure(len);
        for (let k = 0; k < len; k++) { out[op] = out[op - d]; op++; }
      }
    }
  } while (!last);
  return out.slice(0, op);
}
