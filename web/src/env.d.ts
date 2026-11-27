declare const __BUILD_VERSION__: string
declare const __BUILD_TIME__: string

interface ImportMetaEnv {
  /** The API's origin when it is not the page's; empty or unset otherwise. */
  readonly VITE_API_URL?: string
}
