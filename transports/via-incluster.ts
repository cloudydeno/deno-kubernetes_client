import { RestClient, HttpMethods, RequestOptions } from '../common.ts';
import { JsonParsingTransformer, ReadLineTransformer } from "../stream-transformers.ts";

function join(...args: string[]) {
  return args.join('/');
}

/**
 * A RestClient for code which is running within a Kubernetes pod and would like to
 * access the local cluster's control plane using its Service Account (likely the default SA).
 *
 * Deno flags to use this client:
 * Strict: --allow-read=/var/run/secrets/kubernetes.io/ --allow-net=kubernetes.default.svc.cluster.local --cert=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt
 * Lazy: --allow-read --allow-net --cert=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt
 *
 * As opposed to InClusterUnstableRestClient, this class does not register CA trust.
 * So you need to register the cluster's CA using --cert, as shown above.
 */

export class InClusterRestClient implements RestClient {
  readonly baseUrl: string;
  readonly secretsPath: string;
  readonly defaultNamespace: string;
  readonly #token: string;

  constructor({
    baseUrl = 'https://kubernetes.default.svc.cluster.local',
    secretsPath = '/var/run/secrets/kubernetes.io/serviceaccount',
  }={}) {
    this.baseUrl = baseUrl;
    this.secretsPath = secretsPath;

    this.defaultNamespace = Deno.readTextFileSync(join(secretsPath, 'namespace'));
    this.#token = Deno.readTextFileSync(join(secretsPath, 'token'));
  }

  async performRequest(opts: RequestOptions): Promise<any> {
    let path = opts.path || '/';
    if (opts.querystring) {
      path += `?${opts.querystring}`;
    }
    console.error(opts.method, path);

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.#token}`,
    };

    const accept = opts.accept ?? (opts.expectJson ? 'application/json' : undefined);
    if (accept) headers['Accept'] = accept;

    const contentType = opts.contentType ?? (opts.bodyJson ? 'application/json' : undefined);
    if (contentType) headers['Content-Type'] = contentType;

    const resp = await fetch(this.baseUrl + path, {
      method: opts.method,
      body: opts.bodyStream ?? opts.bodyRaw ?? JSON.stringify(opts.bodyJson),
      redirect: 'error',
      signal: opts.abortSignal,
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
// export default InClusterRestClient;
