import path from 'path'
import { app, dialog, type BrowserWindow, type MessageBoxOptions } from 'electron'
import { KeyUnavailableError } from '@shared/lib/keys/key-manager'
import { installedDesktopKeyManager } from './install-desktop-key-manager'

/**
 * File → Export Browser Vault Key…: the desktop's key recovery and transfer.
 * The key lives in this computer's OS store, so a copy of the data folder
 * alone does not open the vault anywhere else. This writes the key to a file
 * the user picks (main process only: the key never crosses IPC to a renderer,
 * nor reaches a log or an agent). On the other computer that file, placed in
 * Gamut's data folder as `.vault-key` before Gamut starts, is checked against
 * the copied logins and moved into that computer's OS store.
 */
export async function exportVaultKey(parent: BrowserWindow | null): Promise<void> {
  const show = (options: MessageBoxOptions) => (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options))
  const manager = installedDesktopKeyManager()
  if (!manager) {
    await show({ type: 'error', message: 'The Browser Vault is not ready yet', detail: 'Try again in a moment.' })
    return
  }
  const confirm = await show({
    type: 'warning',
    message: 'Export the Browser Vault key?',
    detail: [
      'With this file and a copy of Gamut\'s data, anyone can open every login saved in the Browser Vault on this computer. Keep it where only you can reach it, such as a password manager, and delete copies you no longer need.',
      'To move the vault to another computer: copy Gamut\'s data folder there, put this file in it named .vault-key, then start Gamut.',
    ].join('\n\n'),
    buttons: ['Export…', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  })
  if (confirm.response !== 0) return

  const saveOptions = {
    title: 'Export Browser Vault Key',
    defaultPath: path.join(app.getPath('documents'), 'gamut-vault-key.txt'),
    buttonLabel: 'Export',
  }
  const { canceled, filePath } = parent ? await dialog.showSaveDialog(parent, saveOptions) : await dialog.showSaveDialog(saveOptions)
  if (canceled || !filePath) return

  try {
    const result = await manager.exportKeyFile('browser-vault', filePath)
    await show(result === 'no-key'
      ? { type: 'info', message: 'There is no vault key yet', detail: 'Nothing has been saved in the Browser Vault on this computer, so there is nothing to export.' }
      : { type: 'info', message: 'Browser Vault key exported', detail: `Saved to ${filePath}.` })
  } catch (error) {
    await show({
      type: 'error',
      message: 'The Browser Vault key could not be exported',
      detail: error instanceof KeyUnavailableError ? error.userMessage : 'It could not be written to that file.',
    })
  }
}
