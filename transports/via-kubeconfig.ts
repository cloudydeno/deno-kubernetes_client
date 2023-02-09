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
 * CA cert fix: --unstable --allow-read=$HOME/.kube --allow-net --allow-env
 * In-cluster 1: --allow-read=/var/run/secrets/kubernetes.io --allow-net --unstable
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
 * Note that Deno (as of 1.4.1) can't fetch HTTPS IP addresses (denoland/deno#7660)
 * so KUBERNETES_SERVER_HOST can't be used at this time, and would need --allow-env anyway.
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

  static async readKubeConfig(
    path?: string,
    contextName?: string,
  ): Promise<KubeConfigRestClient> {
    return KubeConfigRestClient.forKubeConfig(path
      ? await KubeConfig.readFromPath(path)
      : await KubeConfig.getDefaultConfig(), contextName);
  }

  static async forKubeConfig(
    config: KubeConfig,
    contextName?: string,
  ): Promise<KubeConfigRestClient> {
    const ctx = config.fetchContext(contextName);

    // check early for https://github.com/denoland/deno/issues/7660
    if (ctx.cluster.server) {
      const url = new URL(ctx.cluster.server);
      if (url.hostname.match(/(\]|\.\d+)$/)) throw new Error(
        `Deno cannot access bare IP addresses over HTTPS. See deno#7660.`);
    }

    let userCert = atob(ctx.user["client-certificate-data"] ?? '') || null;
    if (!userCert && ctx.user["client-certificate"]) {
      userCert = await Deno.readTextFile(ctx.user["client-certificate"]);
    }

    let userKey = atob(ctx.user["client-key-data"] ?? '') || null;
    if (!userKey && ctx.user["client-key"]) {
      userKey = await Deno.readTextFile(ctx.user["client-key"]);
    }

    if ((userKey && !userCert) || (!userKey && userCert)) throw new Error(
      `Within the KubeConfig, client key and certificate must both be provided if either is provided.`);

    let serverCert = atob(ctx.cluster["certificate-authority-data"] ?? '') || null;
    if (!serverCert && ctx.cluster["certificate-authority"]) {
      serverCert = await Deno.readTextFile(ctx.cluster["certificate-authority"]);
    }

    // do a little dance to allow running with or without --unstable
    let httpClient: unknown;
    if (serverCert || userKey) {
      if ('createHttpClient' in Deno) {
        httpClient = (Deno as any).createHttpClient({
          caCerts: serverCert ? [serverCert] : [],
          certChain: userCert,
          privateKey: userKey,
        });
      } else if (userKey) {
        console.error('WARN: cannot use certificate-based auth without --unstable');
      } else if (isVerbose) {
        console.error('WARN: cannot have Deno trust the server CA without --unstable');
      }
    }

    return new KubeConfigRestClient(ctx, httpClient);
  }


  async performRequest(opts: RequestOptions): Promise<any> {
    let path = opts.path || '/';
    if (opts.querystring) {
      path += `?${opts.querystring}`;
    }

    if (isVerbose && path !== '/api?healthcheck') {
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