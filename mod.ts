export * from './lib/contract.ts';
export { KubeConfig, KubeConfigContext } from './lib/kubeconfig.ts';
export * from './lib/reflector.ts';
export * from './lib/stream-transformers.ts';

export * from './transports/mod.ts';

/** Paginates through an API request, yielding each successive page as a whole */
export async function* readAllPages<T, U extends {continue?: string | null}>(
  pageFunc: (token?: string) => Promise<{
    metadata: U;
    items: T[];
  }>,
): AsyncGenerator<{
  metadata: U;
  items: T[];
}, void, unknown> {
  let pageToken: string | undefined;
  do {
    const page = await pageFunc(pageToken ?? undefined);
    yield page;
    pageToken = page.metadata.continue ?? undefined;
  } while (pageToken);
}

/** Paginates through an API request, yielding every individual item returned */
export async function* readAllItems<T>(
  pageFunc: (token?: string) => Promise<{
    metadata: {continue?: string | null};
    items: T[];
  }>,
): AsyncGenerator<Awaited<T>, void, undefined> {
  for await (const page of readAllPages(pageFunc)) {
    yield* page.items;
  }
}
