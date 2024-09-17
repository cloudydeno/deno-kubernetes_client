import { TextLineStream } from '../deps.ts';
import { RestClient, RequestOptions, JSONValue } from '../lib/contract.ts';
import { JsonParsingTransformer } from '../lib/stream-transformers.ts';
import { KubeConfig, KubeConfigContext } from '../lib/kubeconfig.ts';

const isVerbose = Deno.args.includes('--verbose');

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
 * CA cert fix: --unstable-http --allow-read=$HOME/.kube --allow-net --allow-env
 * In-cluster 1: --allow-read=/var/run/secrets/kubernetes.io --allow-net --unstable-http
 * In-cluster 2: --allow-read=/var/run/secrets/kubernetes.io --allow-net --cert=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt
 *
 * Unstable features:
 * - using the cluster's CA when fetching (otherwise pass --cert to Deno)
 * - using client auth authentication, if configured
 * - inspecting permissions and prompting for further permissions (TODO)
 *
 * --allow-env is purely to read the $HOME and $KUBECONFIG variables to find your kubeconfig
 *
 * Note that advanced kubeconfigs will need different permissions.
 * This client will prompt you if your config requires extra permissions.
 * Federated auth like AWS IAM or a Google Account are the largest offenders.
 *
 * Note that KUBERNETES_SERVER_HOST is not used for historical reasons.
 * TODO: This variable could be used for an optimization, when available.
 */

export class KubeConfigRestClient implements RestClient {
  constructor(
    protected ctx: KubeConfigContext,
    protected httpClient: unknown,
  ) {
    this.defaultNamespace = ctx.defaultNamespace || 'default';
  }
  defaultNamespace?: string;

  static async forInCluster(): Promise<RestClient> {
    return this.forKubeConfig(
      await KubeConfig.getInClusterConfig());
  }

  static forKubectlProxy(): Promise<RestClient> {
    return this.forKubeConfig(
      KubeConfig.getSimpleUrlConfig({
        baseUrl: 'http://localhost:8001',
      }));
  }

  static async readKubeConfig(
    path?: string,
    contextName?: string,
  ): Promise<RestClient> {
    return this.forKubeConfig(path
      ? await KubeConfig.readFromPath(path)
      : await KubeConfig.getDefaultConfig(), contextName);
  }

  static async forKubeConfig(
    config: KubeConfig,
    contextName?: string,
  ): Promise<RestClient> {
    const ctx = config.fetchContext(contextName);

    const serverTls = await ctx.getServerTls();
    const tlsAuth = await ctx.getClientTls();

    let httpClient: unknown;
    if (serverTls || tlsAuth) {
      if (Deno.createHttpClient) {
        httpClient = Deno.createHttpClient({
          caCerts: serverTls ? [serverTls.serverCert] : [],
          //@ts-ignore-error deno unstable API. Not typed?
          cert: tlsAuth?.userCert,
          key: tlsAuth?.userKey,
        });
      } else if (tlsAuth) {
        console.error('WARN: cannot use certificate-based auth without --unstable');
      } else if (isVerbose) {
        console.error('WARN: cannot have Deno trust the server CA without --unstable');
      }
    }

    return new this(ctx, httpClient);
  }

  async performRequest(opts: RequestOptions): Promise<any> {
    let path = opts.path || '/';
    if (opts.querystring) {
      path += `?${opts.querystring}`;
    }

    if (isVerbose && path !== '/api?healthcheck') {
      console.error(opts.method, path);
    }

    if (opts.expectTunnel) throw new Error(
      `Channel-based APIs are not currently implemented by this client.`);

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

    // If we got a fixed-length JSON body with an HTTP 4xx/5xx, we can assume it's an error
    if (!resp.ok && resp.headers.get('content-type') == 'application/json' && resp.headers.get('content-length')) {
      const bodyJson = await resp.json();
      const error: HttpError = new Error(`Kubernetes returned HTTP ${resp.status} ${bodyJson.reason}: ${bodyJson.message}`);
      error.httpCode = resp.status;
      error.status = bodyJson;
      throw error;
    }

    if (opts.expectStream) {
      if (!resp.body) return new ReadableStream();
      if (opts.expectJson) {
        return resp.body
          .pipeThrough(new TextDecoderStream('utf-8'))
          .pipeThrough(new TextLineStream())
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

type HttpError = Error & {
  httpCode?: number;
  status?: JSONValue;
}
