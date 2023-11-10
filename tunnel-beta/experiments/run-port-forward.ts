import { KubernetesTunnel, RestClient } from "../../lib/contract.ts";

export class PortForwardTunnel {
  constructor(
    private tunnel: KubernetesTunnel,
  ) {}
  private nextRequestId = 0;

  static async connectUsing(client: RestClient, opts: {
    namespace?: string;
    podName: string;
    querystring?: URLSearchParams;
  }) {
    const namespace = opts.namespace ?? client.defaultNamespace ?? 'default';
    const tunnel = await client.performRequest({
      method: 'POST',
      path: `/api/v1/namespaces/${namespace}/pods/${opts.podName}/portforward`,
      querystring: opts.querystring,
      expectTunnel: ['portforward.k8s.io'],
    });

    if (tunnel.transportProtocol == 'WebSocket') {
      await tunnel.stop();
      throw new Error(`Kubernetes PortForwarding is too limited on WebSocket and is not implemented here`);
    }

    await tunnel.ready();
    return new this(tunnel);
  }

  async connectToPort(port: number) {
    const requestID = this.nextRequestId++;
    const [errorStream, stream] = await Promise.all([
      this.tunnel.getChannel({
        spdyHeaders: {
          streamType: 'error',
          port,
          requestID,
        },
        writable: false,
        readable: true,
      }),
      this.tunnel.getChannel({
        spdyHeaders: {
          streamType: 'data',
          port,
          requestID,
        },
        readable: true,
        writable: true,
      }),
    ]);
    console.error('Got streams');

    const errorBody = new Response(errorStream.readable).text();
    errorBody.then(text => {
      if (text.length > 0) {
        console.error("Received portforward error response:", text);
      }
    });

    return {
      result: errorBody,
      stream,
    }
  }

  servePortforward(opts: Deno.ListenOptions & {
    targetPort: number;
  }) {
    const listener = Deno.listen(opts);
    (async () => {
      for await (const conn of listener) {
        const {stream, result} = await this.connectToPort(opts.targetPort);
        console.error('Client connection opened');
        Promise.all([
          result,
          conn.readable.pipeTo(stream.writable),
          stream.readable.pipeTo(conn.writable),
        ]).then(x => {
          console.error('Client connection closed.', x[0]);
        }).catch(err => {
          console.error('Client connection crashed:', err.stack);
        });
      }
    })();
    return listener;
  }

  disconnect() {
    this.tunnel.disconnect();
  }
}
