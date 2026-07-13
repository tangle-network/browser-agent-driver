/**
 * Load an optionalDependency at call time, converting a missing install into an
 * actionable error instead of a raw ERR_MODULE_NOT_FOUND stack trace.
 *
 * The CLI-backed providers (codex-cli, claude-code) pull heavy platform-native
 * binaries and are declared in package.json `optionalDependencies`. A consumer
 * that installs the driver with `--omit=optional` — e.g. the slim agent-thin
 * sandbox image, which only ever runs `--provider openai` — will not have them.
 * Selecting such a provider then fails here with a clear message rather than an
 * opaque module-resolution error. The default `openai` path never calls this.
 *
 * Pass a thunk (`() => import('pkg')`) rather than a bare specifier so the
 * static import type is preserved and the caller keeps full type-checking on the
 * resolved module.
 */
export async function loadOptionalModule<T>(
  load: () => Promise<T>,
  specifier: string,
  usedFor: string,
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const message = error instanceof Error ? error.message : String(error);
    if (
      code === 'ERR_MODULE_NOT_FOUND' ||
      code === 'MODULE_NOT_FOUND' ||
      /Cannot find (module|package)/i.test(message)
    ) {
      throw new Error(
        `${usedFor} requires the optional package "${specifier}", which is not installed. ` +
          "Reinstall @tangle-network/browser-agent-driver without `--omit=optional` to enable it, " +
          "or use a provider whose dependencies are present (for example --provider openai).",
      );
    }
    throw error;
  }
}
