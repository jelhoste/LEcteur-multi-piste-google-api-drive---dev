// Worker d'étirement : une ou plusieurs pistes (un moteur WebAssembly chacune), traitées hors du fil principal et du fil audio.
importScripts('vendor/signalsmith/signalsmith-stretch-wasm.js', 'stretch-core.js');
const handle = self.StretchCore.createHandler(self.SignalsmithStretch, (msg, transfer) => self.postMessage(msg, transfer || []));
self.onmessage = e => handle(e.data);
