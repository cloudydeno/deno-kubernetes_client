import { RestClient, HttpMethods, RequestOptions } from '../lib/contract.ts';
import { JsonParsingTransformer, ReadLineTransformer } from "../lib/stream-transformers.ts";
import { KubeConfig, KubeConfigContext } from '../lib/kubeconfig.ts';

/**
 * A RestClient which uses a KubeConfig to talk directly to a Kubernetes endpoint.
 * Used by code which is running within a Kubernetes pod and would like to
 * access the local cluster's control plane using its Service Account.
 *
 * Also useful for some development workflows,
 * such as interacting with `kubectl proxy` or even directly in certain cases.
 * Unfortunately Deno's fetch() is still a bit gimped for server use
 * so this client works best for simple cases.
 *
 * Deno flags to use this client:
 * Basic KubeConfig: --allow-read=$HOME/.kube --allow-net --allow-env
 * CA cert fix: --unstable --allow-read=$HOME/.kube --allow-net --allow-env
 * In-cluster: --allow-read=/var/run/secrets/kubernetes.io --allow-net --cert=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt
 *
 * Unstable features:
 * - using the cluster's CA when fetching (otherwise pass --cert to Deno)
 * - inspecting permissions and prompting for further permissions (TODO)
 *
 * --allow-env is purely to read the $HOME and $KUBECONFIG variables to find your kubeconfig
 *
 * Note that advanced kubeconfigs will need different permissions.
 * This client will prompt you if your config requires extra permissions.
 * Federated auth like AWS IAM or a Google Account are the largest offenders.
 *
 * Note that Deno (as of 1.4.1) can't fetch HTTPS IP addresses (denoland/deno#7660)
 * so KUBERNETES_SERVER_HOST can't be used at this time, and would need --allow-env anyway.
 *
 * Note that Deno (as of 1.7.5) can't supply client certificates (TODO: file an issue)
 * so certificate based auth is currently not possible.
 */

export class KubeConfigRestClient implements RestClient {
  constructor(
    private ctx: KubeConfigContext,
    private httpClient: unknown,
  ) {
    this.defaultNamespace = ctx.defaultNamespace || 'default';
  }
  defaultNamespace?: string;

  static async forInCluster() {
    return KubeConfigRestClient.forKubeConfig(
      await KubeConfig.getInClusterConfig());
  }

  static async forKubectlProxy() {
    return KubeConfigRestClient.forKubeConfig(
      KubeConfig.getSimpleUrlConfig({
        baseUrl: 'http://localhost:8001',
      }));
  }

  static async readKubeConfig(path?: string): Promise<KubeConfigRestClient> {
    return KubeConfigRestClient.forKubeConfig(path
      ? await KubeConfig.readFromPath(path)
      : await KubeConfig.getDefaultConfig());
  }

  static async forKubeConfig(config: KubeConfig): Promise<KubeConfigRestClient> {
    const ctx = config.fetchContext();

    // check early for https://github.com/denoland/deno/issues/7660
    if (ctx.cluster.server) {
      const url = new URL(ctx.cluster.server);
      if (url.hostname.match(/(\]|\.\d+)$/)) throw new Error(
        `Deno cannot access bare IP addresses over HTTPS. See #7660.`);
    }

    let caData = ctx.cluster["certificate-authority-data"];
    if (!caData && ctx.cluster["certificate-authority"]) {
      caData = await Deno.readTextFile(ctx.cluster["certificate-authority"]);
    }

    // do a little dance to allow running with or without --unstable
    let httpClient: unknown;
    if (caData) {
      if ('createHttpClient' in Deno) {
        httpClient = (Deno as any).createHttpClient({
          caData,
        });
      } else {
        console.error('debug: cannot have Deno trust the server CA without --unstable');
      }
    }

    return new KubeConfigRestClient(ctx, httpClient);
  }


  async performRequest(opts: RequestOptions): Promise<any> {
    let path = opts.path || '/';
    if (opts.querystring) {
      path += `?${opts.querystring}`;
    }

    if (path !== '/api?healthcheck') {
      console.error(opts.method, path);
    }

    const headers: Record<string, string> = {};

    if (!this.ctx.cluster.server) throw new Error(`No server URL found in KubeConfig`);
    const authHeader = await this.ctx.getAuthHeader();
    if (authHeader) {
      headers['Authorization'] = authHeader;
    }

    const accept = opts.accept ?? (opts.expectJson ? 'application/json' : undefined);
    if (accept) headers['Accept'] = accept;

    const contentType = opts.contentType ?? (opts.bodyJson ? 'application/json' : undefined);
    if (contentType) headers['Content-Type'] = contentType;

    const resp = await fetch(new URL(path, this.ctx.cluster.server), {
      method: opts.method,
      body: opts.bodyStream ?? opts.bodyRaw ?? JSON.stringify(opts.bodyJson),
      redirect: 'error',
      signal: opts.abortSignal,
      client: this.httpClient,
      headers,
    } as RequestInit);

    if (opts.expectStream) {
      if (!resp.body) return new ReadableStream();
      if (opts.expectJson) {
        return resp.body
          .pipeThrough(new ReadLineTransformer('utf-8'))
          .pipeThrough(new JsonParsingTransformer());
      } else {
        return resp.body;
      }

    } else if (opts.expectJson) {
      return resp.json();

    } else {
      return new Uint8Array(await resp.arrayBuffer());
    }
  }
}
