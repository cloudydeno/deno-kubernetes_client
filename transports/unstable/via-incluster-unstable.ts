import { RestClient, HttpMethods, RequestOptions } from '../../common.ts';
import { JsonParsingTransformer, ReadLineTransformer } from "../../stream-transformers.ts";

function join(...args: string[]) {
  return args.join('/');
}

/**
 * A RestClient for code which is running within a Kubernetes pod and would like to
 * access the local cluster's control plane using its Service Account (likely the default SA).
 *
 * Deno flags to use this client:
 * Strict: --unstable --allow-read=/var/run/secrets/kubernetes.io/ --allow-net=kubernetes.default.svc
 * Lazy: --unstable --allow-read --allow-net
 *
 * Unstable features:
 * - using a caFile when fetching
 *
 * Note that Deno (as of 1.4.1) can't fetch HTTPS IP addresses (denoland/deno#7660)
 * so KUBERNETES_SERVER_HOST can't be used at this time, and would need --allow-env anyway.
 */

export class InClusterUnstableRestClient implements RestClient {
  readonly baseUrl: string;
  readonly secretsPath: string;
  readonly defaultNamespace: string;
  readonly #httpClient: Deno.HttpClient;
  readonly #token: string;

  constructor({
    baseUrl = 'https://kubernetes.default.svc.cluster.local',
    secretsPath = '/var/run/secrets/kubernetes.io/serviceaccount',
  }={}) {
    this.baseUrl = baseUrl;
    this.secretsPath = secretsPath;

    this.defaultNamespace = Deno.readTextFileSync(join(secretsPath, 'namespace'));
    this.#httpClient = Deno.createHttpClient({ caFile: join(secretsPath, `ca.crt`) });
    this.#token = Deno.readTextFileSync(join(secretsPath, 'token'));
  }

  async performRequest(opts: RequestOptions): Promise<any> {
    let path = opts.path || '/';
    if (opts.querystring) {
      path += `?${opts.querystring}`;
    }
    console.error(opts.method, path);

    const resp = await fetch(this.baseUrl + path, {
      method: opts.method,
      body: opts.bodyStream ?? opts.bodyRaw ?? JSON.stringify(opts.bodyJson),
      redirect: 'error',
      signal: opts.abortSignal,
      headers: {
        'Authorization': `Bearer ${this.#token}`,
        'Accept': opts.accept ?? (opts.expectJson ? 'application/json' : 'application/octet-stream'),
      },
      client: this.#httpClient,
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
export default InClusterUnstableRestClient;
