import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, is } from '@electron-toolkit/utils'
import { getDb, closeDb } from './db'
import { registerWhatsappHandlers, cleanupWhatsappHandlers } from './ipc/whatsapp-handlers'
import { startWhatsappSource, ensureWhatsappDownloadInterceptor } from './whatsapp/session'
import { startAnalysisBatch, stopWhatsappObserver } from './whatsapp/observer'
import { loadDotEnv } from './config/env'

// Main-process orchestrator. This is the ONLY privileged surface: it owns the WhatsApp Web
// session (the embedded <webview> + its DOM detector), the local SQLite store, and the OS
// keychain. The renderer never gets raw ipcRenderer or any secret — everything crosses the
// typed IPC bridge (src/shared/ipc-contract.ts).

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: !is.dev,
      // Allow the embedded WhatsApp Web <webview>. The guest is hardened separately (its own
      // partition, nodeIntegration off, contextIsolation on).
      webviewTag: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  // Cmd/Ctrl+R reload · Cmd/Ctrl+Shift+I toggle DevTools
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta)) return
    const key = input.key.toLowerCase()
    if (key === 'r' && !input.shift) mainWindow.webContents.reload()
    if (key === 'i' && input.shift) mainWindow.webContents.toggleDevTools()
  })

  // Open external links in the OS browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.vasanthamana.jeeves')
  loadDotEnv() // dev: pull PA_* keys from a gitignored .env into process.env

  getDb() // open + migrate the local SQLite store
  ipcMain.handle('app:getVersion', () => app.getVersion())
  // Jeeves has no separate "connect" step — the WhatsApp source starts every boot. session.ts's
  // own whatsappMode() (the persisted demo toggle, else PA_WHATSAPP_MODE) decides live vs mock.
  startWhatsappSource()
  ensureWhatsappDownloadInterceptor() // voice-note download capture — armed regardless of session state
  startAnalysisBatch() // fixed-interval group-activity (ritual clubbing) digest; also runnable on demand
  registerWhatsappHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  ipcMain.removeHandler('app:getVersion')
  cleanupWhatsappHandlers()
  stopWhatsappObserver()
  closeDb()
})
