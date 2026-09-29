import { WhatsAppView } from './components/whatsapp/whatsapp-view'

// Jeeves' whole shell: one WhatsApp Web copilot pane, no nav, no other views. The upstream app
// this was extracted from kept WhatsApp mounted permanently beside several other tabs (Chat,
// Triage, Automations, …) so the embedded <webview> never reloaded on tab switch — here it's
// simply the only thing on screen, so that constraint is moot.

export default function App(): React.JSX.Element {
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
        <h1 className="text-sm font-semibold">Jeeves</h1>
      </header>
      <WhatsAppView />
    </div>
  )
}
