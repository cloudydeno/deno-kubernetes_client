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

export function makeClientProviderChain(restClientConstructor: typeof KubeConfigRestClient) {
  return new ClientProviderChain([
    ['InCluster', () => restClientConstructor.forInCluster()],
    ['KubeConfig', () => restClientConstructor.readKubeConfig()],
    ['KubectlProxy', () => restClientConstructor.forKubectlProxy()],
    ['KubectlRaw', () => Promise.resolve(new KubectlRawRestClient())],
  ]);
}

export const DefaultClientProvider = makeClientProviderChain(KubeConfigRestClient);

/**
 * Trial-and-error approach for automatically deciding how to talk to Kubernetes.
 * You'll still need to set the correct permissions for where you are running.
 * You can probably be more specific and secure with app-specific Deno.args flags.
 */
export async function autoDetectClient(): Promise<RestClient> {
  return await DefaultClientProvider.getClient();
}
