// Worker de conversion : charge FFmpeg (décodage AAC) et libopus (encodage), tous deux en WebAssembly et embarqués dans l'application.
importScripts('opus-pack.js', 'convert-core.js', 'vendor/opus/opusscript_native_wasm.js');
const createOpus = self.Module;                                   // fabrique d'opusscript (variable globale « Module »)
importScripts('vendor/ffmpeg/ffmpeg-core.js');
let core = null, opus = null, starting = null;

// Empreinte SHA-256 du .wasm de FFmpeg une fois décompressé : si elle ne correspond pas, le fichier est altéré ou incomplet.
const FFMPEG_WASM_SHA256 = '9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7';
async function loadFfmpegWasm() {
  if (typeof DecompressionStream === 'undefined') throw new Error('Ce navigateur est trop ancien pour décompresser l\'encodeur (DecompressionStream manquant).');
  const res = await fetch('vendor/ffmpeg/ffmpeg-core.wasm.gz');
  if (!res.ok) throw new Error('Impossible de charger l\'encodeur (HTTP ' + res.status + ').');
  let bin;
  try { bin = new Uint8Array(await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()); }
  catch (e) { throw new Error('Fichier de l\'encodeur incomplet ou illisible (connexion interrompue ?) : rechargez la page.'); }
  if (await self.ConvertCore.sha256Hex(bin) !== FFMPEG_WASM_SHA256) throw new Error('Fichier de l\'encodeur altéré ou incomplet (empreinte SHA-256 différente) : rechargez la page.');
  return bin;
}
async function start() {
  try {
    const c = await self.createFFmpegCore({ wasmBinary: await loadFfmpegWasm() });   // le .wasm est fourni décompressé : pas de téléchargement par le noyau
    const o = createOpus({ locateFile: f => 'vendor/opus/' + f });
    await o.ready;
    core = c; opus = o;                                              // les deux ensemble, ou rien
  } catch (e) { core = opus = starting = null; throw e; }           // permet de réessayer proprement
}
self.onmessage = async e => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      starting = start();
      await starting; self.postMessage({ type: 'ready' });
    } else if (m.type === 'convert') {
      if (!core || !opus) await (starting || (starting = start()));
      const r = await self.ConvertCore.convertM4a(core, opus, m.name, m.bytes, self.ConvertCore.PROFILE, (phase, p) => self.postMessage({ type: 'progress', id: m.id, phase, p }));
      self.postMessage({ type: 'done', id: m.id, name: m.name, bytes: r.bytes, stats: r.stats }, [r.bytes.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: m.type === 'init' ? 'fatal' : 'error', id: m.id, message: (err && err.message) || String(err) });
  }
};
