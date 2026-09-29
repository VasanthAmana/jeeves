import type { IpcInvokeChannels, IpcEventChannels } from '@shared/ipc-contract'

// Typed wrapper over the preload bridge — gives the renderer full type-safety on channels.

const api = window.electronAPI

export function invoke<C extends keyof IpcInvokeChannels>(
  channel: C,
  ...args: IpcInvokeChannels[C]['args']
): Promise<IpcInvokeChannels[C]['return']> {
  return api.invoke(channel, ...args) as Promise<IpcInvokeChannels[C]['return']>
}

export function on<C extends keyof IpcEventChannels>(
  channel: C,
  callback: (payload: IpcEventChannels[C]) => void
): () => void {
  return api.on(channel, (payload) => callback(payload as IpcEventChannels[C]))
}
