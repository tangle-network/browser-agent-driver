export interface ChromeDebugCommandOptions {
  attachPort: string | undefined;
  userDataDir: string | undefined;
  quiet: boolean;
}

export async function handleChromeDebugCommand({ attachPort, userDataDir, quiet }: ChromeDebugCommandOptions): Promise<void> {
  const { runChromeDebugCommand } = await import('../../cli-attach.js')
  const port = attachPort ? parseInt(attachPort, 10) : undefined
  const rc = await runChromeDebugCommand({
    port,
    userDataDir,
    quiet,
  })
  process.exit(rc)
}
