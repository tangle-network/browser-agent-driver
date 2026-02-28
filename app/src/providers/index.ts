/**
 * Provider registry — factory function for creating SandboxProvider instances.
 */

import type { SandboxProvider, ProviderConfig } from '../types.js';

export { DockerSandboxProvider } from './docker.js';
export { TangleSandboxProvider } from './tangle.js';

/** Create a SandboxProvider from a config object */
export async function createProvider(providerConfig: ProviderConfig): Promise<SandboxProvider> {
  switch (providerConfig.type) {
    case 'docker': {
      const { DockerSandboxProvider } = await import('./docker.js');
      return new DockerSandboxProvider(providerConfig.config);
    }
    case 'tangle': {
      const { TangleSandboxProvider } = await import('./tangle.js');
      return new TangleSandboxProvider(providerConfig.config);
    }
    default: {
      const exhaustive: never = providerConfig;
      throw new Error(`Unknown provider type: ${(exhaustive as ProviderConfig).type}`);
    }
  }
}
