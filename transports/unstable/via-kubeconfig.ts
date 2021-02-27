import { RestClient, HttpMethods, RequestOptions } from '../../lib/contract.ts';
import { JsonParsingTransformer, ReadLineTransformer } from "../../lib/stream-transformers.ts";
import { KubeConfig } from '../../lib/kubeconfig.ts';

/**
 * A RestClient for code which is running within a Kubernetes pod and would like to
 * access the local cluster's control plane using its Service Account (likely the default SA).
 *
 * Deno flags to use this client:
 * Basic: --unstable --allow-read --allow-write --allow-net --allow-env
 * Strict: --unstable --allow-read=$HOME/.kube --allow-write=$HOME/.kube --allow-net
 * Lazy: --unstable --allow-all
 *
 * Unstable features:
 * - using a caFile when fetching
 * - inspecting permissions and prompting for further permissions
 *
 * --allow-env is purely to read the $HOME variable to find your kubeconfig
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
    private kubeConfig: KubeConfig,
    private httpClient: Deno.HttpClient,
    namespace?: string
  ) {
    this.defaultNamespace = namespace;
  }
  defaultNamespace?: string;

  static async fromKubeConfig(path?: string): Promise<KubeConfigRestClient> {

    const config = await (path ? KubeConfig.readFromPath(path) : KubeConfig.getDefaultConfig());
    const ctx = config.fetchContext();

    let caData = ctx.cluster["certificate-authority-data"];
    if (!caData && ctx.cluster["certificate-authority"]) {
      caData = await Deno.readTextFile(ctx.cluster["certificate-authority"]);
    }

    const httpClient = Deno.createHttpClient({
      caData,
    });

    return new KubeConfigRestClient(config, httpClient, ctx.defaultNamespace || 'default');
  }


  async performRequest(opts: RequestOptions): Promise<any> {
    let path = opts.path || '/';
    if (opts.querystring) {
      path += `?${opts.querystring}`;
    }
    console.error(opts.method, path);

    const headers: Record<string, string> = {};

    const ctx = this.kubeConfig.fetchContext();
    if (!ctx.cluster.server) throw new Error(`No server URL found in KubeConfig`);
    const authHeader = await ctx.getAuthHeader();
    if (authHeader) {
      headers['Authorization'] = authHeader;
    }

    const accept = opts.accept ?? (opts.expectJson ? 'application/json' : undefined);
    if (accept) headers['Accept'] = accept;

    const contentType = opts.contentType ?? (opts.bodyJson ? 'application/json' : undefined);
    if (contentType) headers['Content-Type'] = contentType;

    const resp = await fetch(new URL(path, ctx.cluster.server), {
      method: opts.method,
      body: opts.bodyStream ?? opts.bodyRaw ?? JSON.stringify(opts.bodyJson),
      redirect: 'error',
      signal: opts.abortSignal,
      client: this.httpClient,
      headers,
    });

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
