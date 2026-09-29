import { contextBridge, ipcRenderer } from 'electron'
import { INVOKE_CHANNELS, EVENT_CHANNELS } from '../shared/ipc-contract'

// The ONLY bridge between renderer and main. contextIsolation is on and the renderer
// never sees raw ipcRenderer — every channel is allow-listed from the shared contract,
// so the allow-list can never drift from the typed channel definitions.

const invokeAllowed: readonly string[] = INVOKE_CHANNELS
const eventAllowed: readonly string[] = EVENT_CHANNELS

const electronAPI = {
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> => {
    if (invokeAllowed.includes(channel)) {
      return ipcRenderer.invoke(channel, ...args)
    }
    return Promise.reject(new Error(`Channel "${channel}" is not allowed`))
  },
  on: (channel: string, callback: (...args: unknown[]) => void): (() => void) => {
    if (eventAllowed.includes(channel)) {
      const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    }
    return () => {}
  },
  removeAllListeners: (channel: string): void => {
    ipcRenderer.removeAllListeners(channel)
  }
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
