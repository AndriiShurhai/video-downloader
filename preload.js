const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  engine: () => ipcRenderer.invoke('engine'),
  info: (url) => ipcRenderer.invoke('info', url),
  start: (opts) => ipcRenderer.invoke('start', opts),
  cancel: (id) => ipcRenderer.send('cancel', id),
  getDir: () => ipcRenderer.invoke('get-dir'),
  chooseDir: () => ipcRenderer.invoke('choose-dir'),
  reveal: (p) => ipcRenderer.send('reveal', p),
  onProgress: (cb) => ipcRenderer.on('progress', (_, d) => cb(d)),
  onEngine: (cb) => ipcRenderer.on('engine', (_, d) => cb(d)),
});
