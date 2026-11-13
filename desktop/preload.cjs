const { contextBridge, ipcRenderer } = require('electron');

const SHRI_PRINT_DESKTOP_API = {
  windowAction: action => ipcRenderer.send('shri-print:window-control', action),
  getStatus: () => ipcRenderer.invoke('shri-print:get-status'),
  setMode: mode => ipcRenderer.invoke('shri-print:set-mode', mode),
  reconnect: () => ipcRenderer.invoke('shri-print:reconnect'),
  onStatusUpdate: callback => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('shri-print:status-update', handler);
    return () => ipcRenderer.off('shri-print:status-update', handler);
  },
};

contextBridge.exposeInMainWorld('shriPrintDesktop', SHRI_PRINT_DESKTOP_API);
