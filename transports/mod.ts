import { KubectlRawRestClient } from './via-kubectl-raw.ts';
import { KubeConfigRestClient } from './via-kubeconfig.ts';
export { KubectlRawRestClient, KubeConfigRestClient };

import type { RestClient } from '../lib/contract.ts';

type ClientProvider = () => Promise<RestClient>;
export class ClientProviderChain {
  constructor(
    public chain: Array<[string, ClientProvider]>,
  ) {}
  async getClient(): Promise<RestClient> {
    const errors: Array<string> = [];
    for (const [label, factory] of this.chain) {
      try {
        const creds = await factory();
        const {kind} = await creds.performRequest({
          method: 'GET',
          path: '/api?healthcheck',
          expectJson: true,
        }) as { kind?: string };
        if (kind !== 'APIVersions') throw new Error(
          `Didn't see a Kubernetes API surface at /api`);
        return creds;
      } catch (err) {
        const srcName = `  - ${label} `;
        if (err instanceof Error) {
          // if (err.message !== 'No credentials found') {
            errors.push(srcName+(err.stack?.split('\n')[0] || err.message));
          // }
        } else if (err) {
          errors.push(srcName+err.toString());
        }
      }
    }
    return Promise.reject(new Error([
      `Failed to load any possible Kubernetes clients:`,
    ...errors].join('\n')));
  }
}

/** Constructs the typical list of Kubernetes API clients,
 * using an alternative client for connecting to KubeConfig contexts.
 * The Kubectl client is unaffected by this. */
export function makeClientProviderChain(restClientFactory: KubeConfigClientFactory) {
  return new ClientProviderChain([
    ['InCluster', () => restClientFactory.forInCluster()],
    ['KubeConfig', () => restClientFactory.readKubeConfig()],
    ['KubectlProxy', () => restClientFactory.forKubectlProxy()],
    ['KubectlRaw', () => Promise.resolve(new KubectlRawRestClient())],
  ]);
}

/** A subset of KubeConfigRestClient's static interface. */
interface KubeConfigClientFactory {
  forInCluster(): Promise<RestClient>;
  forKubectlProxy(): Promise<RestClient>;
  readKubeConfig(
    path?: string,
    contextName?: string,
  ): Promise<RestClient>;
}

export const DefaultClientProvider = makeClientProviderChain(KubeConfigRestClient);

/**
 * Automatic trial-and-error approach for deciding how to talk to Kubernetes.
 * Influenced by Deno's current permissions and Deno may prompt for more permissions.
 * Will emit a list of problems if no usable clients are found.
 * You'll likely want to set the correct Deno permissions for your installation.
 */
export async function autoDetectClient(): Promise<RestClient> {
  return await DefaultClientProvider.getClient();
}
