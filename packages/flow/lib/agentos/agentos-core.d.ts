/** Present when `@rivet-dev/agentos-core` is not installed. Runtime still tries the real package. */
declare module "@rivet-dev/agentos-core" {
  export const AgentOs: {
    create(options: {
      database: { type: "sqlite_file"; path: string }
      rootFilesystem: { type: "native"; plugin: { id: "chunked_sqlite"; config: Record<string, never> } }
    }): Promise<{
      filesystem: {
        writeFile(file: string, data: string | Uint8Array): Promise<void>
        readFile(file: string): Promise<Uint8Array>
      }
      dispose(): Promise<void>
    }>
  }
}
