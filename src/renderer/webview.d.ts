import 'react'

// Electron's <webview> tag — not a standard HTML element, so declare it for TSX. The main
// window enables it via webPreferences.webviewTag. We use only a few attributes + the
// imperative methods below (cast the ref through WaWebview in whatsapp-view.tsx).

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string
          partition?: string
          useragent?: string
          webpreferences?: string
        },
        HTMLElement
      >
    }
  }
}
