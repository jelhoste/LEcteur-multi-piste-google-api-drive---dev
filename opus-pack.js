// opus-pack.js : écrit un fichier Ogg Opus (RFC 7845) à partir de paquets Opus déjà encodés.
// Déterministe : mêmes paquets + mêmes paramètres = mêmes octets (numéro de série fixe, aucune date).
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.OpusPack = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  const CRC = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let r = (i << 24) >>> 0; for (let k = 0; k < 8; k++) r = (r & 0x80000000) ? (((r << 1) ^ 0x04c11db7) >>> 0) : ((r << 1) >>> 0); CRC[i] = r; }
  function crc32(b) { let c = 0; for (let i = 0; i < b.length; i++) c = (((c << 8) >>> 0) ^ CRC[((c >>> 24) ^ b[i]) & 255]) >>> 0; return c >>> 0; }

  function makePage(serial, seq, flags, granule, packets) {
    const lacing = []; let dlen = 0;
    for (const p of packets) { let n = p.length; while (n >= 255) { lacing.push(255); n -= 255; } lacing.push(n); dlen += p.length; }
    if (lacing.length > 255) throw new Error('page Ogg trop grande');
    const buf = new Uint8Array(27 + lacing.length + dlen), dv = new DataView(buf.buffer);
    buf.set([0x4f, 0x67, 0x67, 0x53, 0, flags], 0);
    dv.setUint32(6, granule % 4294967296, true); dv.setUint32(10, Math.floor(granule / 4294967296), true);
    dv.setUint32(14, serial, true); dv.setUint32(18, seq, true);
    buf[26] = lacing.length; buf.set(lacing, 27);
    let o = 27 + lacing.length; for (const p of packets) { buf.set(p, o); o += p.length; }
    dv.setUint32(22, crc32(buf), true);
    return buf;
  }

  // packets : Uint8Array[] (un par trame de `frame` échantillons à 48 kHz) ; samples : durée réelle de l'audio en échantillons à 48 kHz.
  function buildOggOpus(o) {
    const { packets, samples, preSkip = 312, channels = 2, inputRate = 48000, frame = 960, vendor = '', comments = [], serial = 1, packetsPerPage = 50 } = o;
    const te = new TextEncoder(), pages = []; let seq = 0;
    const head = new Uint8Array(19), hv = new DataView(head.buffer);
    head.set(te.encode('OpusHead')); head[8] = 1; head[9] = channels; hv.setUint16(10, preSkip, true); hv.setUint32(12, inputRate, true); hv.setInt16(16, 0, true); head[18] = 0;
    pages.push(makePage(serial, seq++, 0x02, 0, [head]));
    const v = te.encode(vendor), cs = comments.map(c => te.encode(c));
    const tags = new Uint8Array(8 + 4 + v.length + 4 + cs.reduce((n, c) => n + 4 + c.length, 0)), tv = new DataView(tags.buffer);
    tags.set(te.encode('OpusTags')); let p = 8; tv.setUint32(p, v.length, true); p += 4; tags.set(v, p); p += v.length;
    tv.setUint32(p, cs.length, true); p += 4; for (const c of cs) { tv.setUint32(p, c.length, true); p += 4; tags.set(c, p); p += c.length; }
    pages.push(makePage(serial, seq++, 0, 0, [tags]));
    const total = preSkip + samples; let i = 0;
    while (i < packets.length) {
      let segs = 0, n = 0; const grp = [];
      while (i < packets.length && n < packetsPerPage) { const need = Math.floor(packets[i].length / 255) + 1; if (segs + need > 255) break; segs += need; grp.push(packets[i]); i++; n++; }
      const last = i >= packets.length;
      pages.push(makePage(serial, seq++, last ? 0x04 : 0, last ? total : Math.min(i * frame, total), grp));
    }
    const out = new Uint8Array(pages.reduce((n, g) => n + g.length, 0)); let o2 = 0;
    for (const g of pages) { out.set(g, o2); o2 += g.length; }
    return out;
  }
  return { crc32, makePage, buildOggOpus };
});
