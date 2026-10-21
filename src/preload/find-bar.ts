import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('findBar', {
  find: (text: string, forward: boolean, newSearch: boolean) =>
    ipcRenderer.send('find-bar:find', { text, forward, newSearch }),
  close: () => ipcRenderer.send('find-bar:close'),
  onResult: (callback: (result: { active: number; total: number }) => void) => {
    ipcRenderer.on('find-bar:result', (_event, result) => callback(result))
  },
  onFocus: (callback: () => void) => {
    ipcRenderer.on('find-bar:focus', () => callback())
  },
})
