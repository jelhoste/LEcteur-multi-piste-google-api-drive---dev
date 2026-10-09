// convert-core.js : M4A (AAC) -> Ogg Opus, avec un encodeur et des réglages FIGÉS (le « profil »).
// Décodage : FFmpeg (WebAssembly). Encodage : libopus (WebAssembly, via opusscript). Empaquetage : opus-pack.js.
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./opus-pack.js')); else root.ConvertCore = factory(root.OpusPack); })(typeof self !== 'undefined' ? self : this, function (OpusPack) {
  // Pour changer d'encodeur ou de réglages : créer un NOUVEAU profil (nouvel id) ; ne jamais modifier celui-ci après usage.
  const PROFILE = Object.freeze({
    id: 'opus-128-v1',
    label: 'Opus 128 kbit/s VBR, 48 kHz stéréo',
    encoder: Object.freeze({ library: 'libopus', version: '1.4', binding: 'opusscript 0.1.1, WebAssembly' }),
    decoder: Object.freeze({ tool: 'FFmpeg 5.1.4', package: '@ffmpeg/core 0.12.10, WebAssembly' }),
    container: 'Ogg Opus (RFC 7845)',
    sampleRate: 48000, channels: 2, frameSamples: 960, frameMs: 20, preSkip: 312,
    application: 2049, applicationName: 'audio', bitrate: 128000, vbr: true, vbrConstraint: false, complexity: 10,
    decodeArgs: ['-hide_banner', '-i', 'in.m4a', '-vn', '-map', '0:a:0', '-map_metadata', '-1', '-ac', '2', '-ar', '48000', '-f', 's16le', 'pcm.raw'],
    // Équivalent en ligne de commande (pour reproduire avec un ffmpeg de bureau ; les octets ne seront pas identiques) :
    desktopEquivalent: 'ffmpeg -i entree.m4a -c:a libopus -b:a 128k -vbr on -application audio -ar 48000 -ac 2 sortie.opus',
  });
  const profileTag = p => `${p.encoder.library} ${p.encoder.version} (${p.encoder.binding})`;
  const settingsTag = p => `${p.bitrate / 1000}kbps vbr=${p.vbr ? (p.vbrConstraint ? 'constrained' : 'on') : 'off'} complexity=${p.complexity} application=${p.applicationName} ${p.sampleRate}Hz ${p.channels}ch frame=${p.frameMs}ms`;

  async function decodeAac(core, bytes, profile = PROFILE) {
    const logs = []; core.setLogger(({ message }) => logs.push(message)); core.setTimeout(-1);
    core.FS.writeFile('in.m4a', bytes);
    let ret; try { core.exec(...profile.decodeArgs); ret = core.ret; } finally { core.reset(); }
    try { core.FS.unlink('in.m4a'); } catch (e) {}
    if (ret !== 0) { try { core.FS.unlink('pcm.raw'); } catch (e) {} throw new Error('Décodage impossible (code ' + ret + ') : ' + logs.filter(Boolean).slice(-2).join(' | ')); }
    const raw = core.FS.readFile('pcm.raw'); try { core.FS.unlink('pcm.raw'); } catch (e) {}
    const pcm = new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength - (raw.byteLength % 2)));
    const dur = logs.map(l => /Duration:\s*([\d:.]+)/.exec(l)).find(Boolean), st = logs.map(l => /Audio:\s*([^\n]+)/.exec(l)).find(Boolean);
    return { pcm, source: { duration: dur ? dur[1] : null, stream: st ? st[1].trim() : null } };
  }

  function createEncoder(mod, profile = PROFILE) {
    const h = new mod.OpusScriptHandler(profile.sampleRate, profile.channels, profile.application);
    const nBytes = profile.frameSamples * profile.channels * 2;
    // opusscript attend CHAQUE OCTET du PCM 16 bits dans un emplacement de 16 bits de la mémoire WebAssembly (convention de la bibliothèque, vérifiée par test).
    const inPtr = mod._malloc(nBytes * 2 + 64), outPtr = mod._malloc(4000);
    const ctl = (c, v) => { const r = h._encoder_ctl(c, v); if (r < 0) throw new Error('Réglage de l\'encodeur refusé (' + c + ' : ' + r + ')'); };
    ctl(4002, profile.bitrate); ctl(4006, profile.vbr ? 1 : 0); ctl(4020, profile.vbrConstraint ? 1 : 0); ctl(4010, profile.complexity);
    return {
      encode(int16) {
        new Uint16Array(mod.HEAPU8.buffer, inPtr, nBytes).set(new Uint8Array(int16.buffer, int16.byteOffset, nBytes));
        const n = h._encode(inPtr, nBytes, outPtr, profile.frameSamples);
        if (n < 0) throw new Error('Erreur d\'encodage Opus (' + n + ')');
        return mod.HEAPU8.slice(outPtr, outPtr + n);
      },
      free() { mod._free(inPtr); mod._free(outPtr); },
    };
  }

  // pcm : Int16Array entrelacé stéréo 48 kHz. Retourne les paquets Opus ; on encode (durée + pre-skip) pour vider le retard de l'encodeur.
  function encodePcm(mod, pcm, profile = PROFILE, onProgress) {
    const enc = createEncoder(mod, profile), fs = profile.frameSamples * profile.channels, n = pcm.length / profile.channels;
    const frames = Math.ceil((n + profile.preSkip) / profile.frameSamples), packets = [], buf = new Int16Array(fs);
    try {
      for (let f = 0; f < frames; f++) {
        const s = f * fs;
        if (s + fs <= pcm.length) buf.set(pcm.subarray(s, s + fs)); else { buf.fill(0); if (s < pcm.length) buf.set(pcm.subarray(s)); }
        packets.push(enc.encode(buf));
        if (onProgress && f % 250 === 0) onProgress(f / frames);
      }
    } finally { enc.free(); }
    return { packets, samples: n };
  }

  async function sha256Hex(bytes) {
    const d = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
  }

  // Convertit un M4A. Retourne { bytes (Ogg Opus), stats }.
  async function convertM4a(core, mod, name, m4a, profile = PROFILE, onProgress = () => {}) {
    const t0 = Date.now();
    const sourceSha = await sha256Hex(m4a);
    onProgress('decode', 0);
    const { pcm, source } = await decodeAac(core, m4a, profile);
    onProgress('encode', 0);
    const { packets, samples } = encodePcm(mod, pcm, profile, p => onProgress('encode', p));
    const comments = ['ENCODER=' + profileTag(profile), 'PROFILE=' + profile.id, 'SETTINGS=' + settingsTag(profile),
      'DECODER=' + profile.decoder.tool + ' (' + profile.decoder.package + ')', 'SOURCE=' + name, 'SOURCE_SHA256=' + sourceSha];
    const bytes = OpusPack.buildOggOpus({ packets, samples, preSkip: profile.preSkip, channels: profile.channels, inputRate: 48000, frame: profile.frameSamples,
      vendor: profileTag(profile), comments });
    const outSha = await sha256Hex(bytes);
    onProgress('done', 1);
    return { bytes, stats: { samples, seconds: samples / profile.sampleRate, packets: packets.length, inputSize: m4a.length, outputSize: bytes.length, sourceSha256: sourceSha, outputSha256: outSha, source, ms: Date.now() - t0 } };
  }
  return { PROFILE, profileTag, settingsTag, decodeAac, createEncoder, encodePcm, convertM4a, sha256Hex };
});
