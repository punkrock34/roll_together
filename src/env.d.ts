interface ImportMetaEnv {
  readonly WXT_PUBLIC_BACKEND_HTTP_URL?: string;
  readonly WXT_PUBLIC_BACKEND_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
