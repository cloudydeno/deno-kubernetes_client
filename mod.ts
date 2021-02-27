export * from './lib/contract.ts';
export { KubeConfig, KubeConfigContext } from './lib/kubeconfig.ts';
export { Reflector } from './lib/reflector.ts';
export * from './lib/stream-transformers.ts';

/**
 * There are multiple very different types of HTTP client in this repo!
 * Each one has its own usecase, upsides, problems, and flags.
 * Check each file to understand what flags you'll need to pass.
 *
 * This file exports only several clients that don't require --unstable.
 * So it's a pretty sane entrypoint into the client world,
 * especially if you are writing a script locally that
 * you will want to run within a cluster pretty soon.
 */

import { InClusterRestClient } from './transports/via-incluster.ts';
import { KubectlRawRestClient } from './transports/via-kubectl-raw.ts';
export { InClusterRestClient, KubectlRawRestClient };

import type { RestClient } from './lib/contract.ts';

/**
 * Trial-and-error approach for automatically deciding how to talk to Kubernetes.
 * You'll still need to set the correct permissions for where you are running.
 * You can probably be more specific and secure with app-specific Deno.args flags.
 */
export async function autoDetectClient(): Promise<RestClient> {

  // try reading the incluster service account files
  try {
    // TODO: this should be async
    return new InClusterRestClient();
  } catch (err) {
    console.log('debug: InCluster client failed:', err.name);
  }

  // TODO: try hitting localhost:9001 (for KubectlProxyRestClient)

  // fall back to execing kubectl
  // TODO: try execing first (probably to select default namespace)
  return new KubectlRawRestClient();
}


/** Paginates through an API request, yielding each successive page as a whole */
export async function* readAllPages<T, U extends {continue?: string | null}>(pageFunc: (token?: string) => Promise<{metadata: U, items: T[]}>) {
  let pageToken: string | undefined;
  do {
    const page = await pageFunc(pageToken ?? undefined);
    yield page;
    pageToken = page.metadata.continue ?? undefined;
  } while (pageToken);
}

/** Paginates through an API request, yielding every individual item returned */
export async function* readAllItems<T>(pageFunc: (token?: string) => Promise<{metadata: {continue?: string | null}, items: T[]}>) {
  for await (const page of readAllPages(pageFunc)) {
    yield* page.items;
  }
}
