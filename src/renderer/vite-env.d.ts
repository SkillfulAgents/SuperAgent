/// <reference types="vite/client" />

declare const __APP_VERSION__: string
declare const __AUTH_MODE__: boolean
declare const __AMPLITUDE_API_KEY__: string

interface ImportMetaEnv {
  readonly VITE_VERSION?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
