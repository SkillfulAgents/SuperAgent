/// <reference types="vite/client" />

declare const __APP_VERSION__: string
declare const __AUTH_MODE__: boolean

interface ImportMetaEnv {
  readonly VITE_VERSION?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
