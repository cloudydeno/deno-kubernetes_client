import { Connection } from "https://deno.land/x/spdy_transport@v0.1/mod.ts";

import { KubernetesTunnel, JSONValue, RequestOptions } from "../lib/contract.ts";
import { KubeConfigRestClient } from "../transports/via-kubeconfig.ts";

export class SpdyEnabledRestClient extends KubeConfigRestClient {

  async performRequest(opts: RequestOptions) {
    if (!opts.expectTunnel) {
      return super.performRequest(opts);
    }

    if (!this.ctx.cluster.server) throw new Error(`No server URL found in KubeConfig`);
    const url = new URL(this.ctx.cluster.server);

    const clientTls = await this.ctx.getClientTls();
    const serverTls = await this.ctx.getServerTls();

    const tlsSocket = await Deno.connectTls({
      hostname: url.hostname,
      port: url.port ? parseInt(url.port) : 443,
      alpnProtocols: ['http/1.1'],
      caCerts: serverTls?.serverCert ? [serverTls.serverCert] : [],
      certChain: clientTls?.userCert,
      privateKey: clientTls?.userKey,
    });

    const transport = await dialSpdyTunnel({
      tlsSocket,
      hostHeader: url.hostname,
      authHeader: await this.ctx.getAuthHeader(),
      method: opts.method as 'POST',
      path: opts.path,
      streamProtocols: opts.expectTunnel,
      querystring: opts.querystring,
    });

    return new SpdyTunnel(transport.client, transport.subProtocol);
  }
}

export class SpdyTunnel implements KubernetesTunnel {
  constructor(
    private readonly conn: Connection,
    public readonly subProtocol: string,
  ) {
  }
  readonly transportProtocol = "SPDY";

  async getChannel<Treadable extends boolean, Twritable extends boolean>(opts: {
    spdyHeaders?: Record<string, string | number> | undefined;
    streamIndex?: number | undefined;
    readable: Treadable;
    writable: Twritable;
  }) {
    const { spdyHeaders } = opts;
    if (!spdyHeaders) {
      throw new Error("Cannot get a SPDY channel without spdyHeaders.");
    }

    const request = await this.conn.request({
      method: 'GET',
      path: '/',
      headers: spdyHeaders,
      readable: true,
      writable: true,
    });

    return {
      close: () => Promise.resolve(request.destroy()),
      readable: maybe(opts.readable, () => request.readable),
      writable: maybe(opts.writable, () => request.writable),
    };
  }
  async ready(): Promise<void> {
  }
  async stop(): Promise<void> {
    await this.conn.end();
  }
}

type HttpError = Error & {
  httpCode?: number;
  status?: JSONValue;
}


async function dialSpdyTunnel(opts: {
  tlsSocket: Deno.TlsConn;
  hostHeader?: string;
  authHeader: string | null;
  method: 'POST';
  path: string;
  streamProtocols: Array<string>;
  querystring?: URLSearchParams;
  abortSignal?: AbortSignal;
}) {
  let path = opts.path || '/';
  if (opts.querystring) {
    path += `?${opts.querystring}`;
  }

  // Prepare upgrade headers
  const headers = new Headers([
    ["Host", opts.hostHeader ?? "kubernetes.default.svc"],
    ["User-Agent", `Deno/${Deno.version} (+https://deno.land/x/kubernetes_client)`],
    ["Content-Length", "0"],
    ["Connection", "Upgrade"],
    ["Upgrade", "SPDY/3.1"],
  ]);
  for (const protocol of opts.streamProtocols) {
    headers.append("X-Stream-Protocol-Version", protocol);
  }
  if (opts.authHeader) {
    headers.set("Authorization", opts.authHeader);
  }

  const socket = opts.tlsSocket;

  // Write the upgrade request
  const writer = socket.writable.getWriter();
  await writer.write(new TextEncoder().encode([
    `${opts.method} ${path} HTTP/1.1`,
    ...(Array.from(headers).map(x => `${x[0]}: ${x[1]}`)),
    '', '',
  ].join('\r\n')));
  writer.releaseLock();

  // grab the upgrade response header
  // TODO: we should really parse the HTTP message properly...
  const reader = socket.readable.getReader();
  const buff = await reader.read();
  // TODO: error bodies from the kubelet often come back in a second read:
  // console.log(new TextDecoder().decode(await reader.read().then(x => x.value)))
  reader.releaseLock();
  const respText = new TextDecoder().decode(buff.value);

  // HTTP/1.1 101 Switching Protocols
  // Connection: Upgrade
  // Upgrade: SPDY/1.3
  // X-Stream-Protocol-Version: portforward.k8s.io
  // Date: ...

  if (!respText.startsWith('HTTP/1.1 101 ')) {
    socket.close();
    const status = parseInt(respText.split(' ')[1]);
    const bodyJson = await Promise.resolve(respText.split('\r\n\r\n')[1])
      .then(x => JSON.parse(x))
      .catch(() => null);
    const error: HttpError = new Error(bodyJson
      ? `Kubernetes returned HTTP ${status} ${bodyJson.reason}: ${bodyJson.message}`
      : `Kubernetes returned ${respText.split('\r\n')[0]} to tunnel upgrade request. ${respText}`);
    error.httpCode = status;
    error.status = bodyJson;
    throw error;
  }

  // The caller might want to know which subprotocol the server accepted
  const subProtocol = respText.match(/^X-Stream-Protocol-Version: (.+)$/mi)?.[1];
  if (!subProtocol) throw new Error(`BUG: no X-Stream-Protocol-Version header found\n${respText}`);

  const client = new Connection(socket, {
    protocol: 'spdy',
    isServer: false,
    headerCompression: true,
  });

  client.start(3.1);

  return {
    client,
    subProtocol
  };
}

function maybe<Tcond extends boolean, Tres>(cond: Tcond, factory: () => Tres) {
  return (cond ? factory() : null) as (Tcond extends true ? Tres : null);
}
