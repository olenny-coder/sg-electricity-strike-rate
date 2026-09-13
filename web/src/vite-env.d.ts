/// <reference types="vite/client" />

/**
 * Environment variables inlined at build time by Vite.
 * Only variables prefixed with VITE_ are exposed to the client.
 */
interface ImportMetaEnv {
  /**
   * Base URL of the API. Empty (the default) means same-origin, which is
   * correct for the single-process deployment where Fastify serves both the
   * client and /api. Set it only for a split deployment.
   */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
