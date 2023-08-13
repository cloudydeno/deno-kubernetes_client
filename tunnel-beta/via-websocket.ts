import { map } from "https://deno.land/x/stream_observables@v1.3/transforms/map.ts";
import { EOF, external } from "https://deno.land/x/stream_observables@v1.3/sources/external.ts";

import { KubernetesTunnel, RequestOptions } from "../lib/contract.ts";
import { KubeConfigRestClient } from "../transports/via-kubeconfig.ts";

/**
 * Extension of KubeConfigRestClient, adding tunnel support via WebSocketStream.
 * WebSockets have various limits within the Kubernetes and Deno ecosystem,
 * but they work quite well in several situations and have good backpressure support.
 *
 * * For most clusters, you'll need to have Deno trust the cluster CA.
 *   Otherwise you'll get an `UnknownIssuer` error.
 *   In-cluster, you just need to pass `--cert /var/run/secrets/kubernetes.io/serviceaccount/ca.crt`
 *
 * * Restricted for out-of-cluster use due to lack of Client Certificates.
 *   https://github.com/denoland/deno/issues/11846
 *   Workaround of using `kubectl proxy --reject-paths=/^-$/`
 *
 * * Restricted for port-forwarding due to lack of dynamic multiplexing.
 *   Every new port connection requires a new WebSocket.
 *   (TODO: find or create Kubernetes ticket to track this)
 *
 * * stdin restricted for exec/attach due to lack of EOF signal.
 *   Upstream work: https://github.com/kubernetes/kubernetes/pull/119157
 */
export class WebsocketRestClient extends KubeConfigRestClient {
  async performRequest<Tproto extends string>(opts: RequestOptions & {expectTunnel?: Tproto[]}) {
    const requestedProtocols = opts.expectTunnel;
    if (!requestedProtocols) {
      return super.performRequest(opts);
    }

    const headers: Record<string, string> = {};

    if (!this.ctx.cluster.server) throw new Error(`No server URL found in KubeConfig`);
    const authHeader = await this.ctx.getAuthHeader();
    if (authHeader) {
      headers['Authorization'] = authHeader;
    }

    let path = opts.path || '/';
    if (opts.querystring) {
      path += `?${opts.querystring}`;
    }

    const url = new URL(path, this.ctx.cluster.server);
    url.protocol = url.protocol.replace('http', 'ws');

    const serverWs = new WebSocketStream(url.toString(), {
      headers,
      protocols: opts.expectTunnel,
      signal: opts.abortSignal,
    });

    const serverConn = await serverWs.connection;
    return new WebsocketTunnel(serverWs, serverConn);
  }
}

/**
 * Handles an individual WebSocket connection to the Kubernetes API.
 * Kubernetes WebSockets support up to 255 indexed bytestreams.
 * To send or receive data, you must first provide the channel's index,
 * and then streams will be returned for that particular index.
 *
 * WebSocket channels do not support closing individual streams.
 * You must disconnect the overall tunnel if you wish to end things.
 */
export class WebsocketTunnel implements KubernetesTunnel {
  constructor(
    private readonly wss: WebSocketStream,
    wssConn: WebSocketConnection,
  ) {
    this.subProtocol = wssConn.protocol;
    this.done = this.upstreamChannels.observable
      .pipeThrough(mergeAll())
      .pipeThrough(wssConn)
      .pipeThrough(map(async chunk => {
        if (typeof chunk == 'string') throw new Error(`Unexpected`);
        const channelNum = chunk.at(0);
        if (typeof channelNum != 'number') throw new Error(`Unexpected`);
        const downstream = this.downstreamChannels.get(channelNum);
        if (!downstream) throw new Error(`Channel ${channelNum} not reading`);
        await downstream.write(chunk.slice(1));
      }))
      .pipeTo(new WritableStream())
      .finally(() => {
        this.upstreamChannels.next(EOF);
        for (const downstream of this.downstreamChannels.values()) {
          downstream.close();
        }
      });
  }
  readonly transportProtocol = "WebSocket";
  readonly subProtocol: string;
  readonly done: Promise<void>;

  private upstreamChannels = external<ReadableStream<Uint8Array>>();
  private downstreamChannels = new Map<number, WritableStreamDefaultWriter<Uint8Array>>();

  getChannel<Treadable extends boolean, Twritable extends boolean>(opts: {
    spdyHeaders?: Record<string, string | number> | undefined;
    streamIndex?: number | undefined;
    readable: Treadable;
    writable: Twritable;
  }) {
    const { streamIndex } = opts;
    if (typeof streamIndex !== 'number') {
      throw new Error("Cannot get a WebSocket channel without a streamIndex.");
    }

    return Promise.resolve({
      writable: maybe(opts.writable, () => {
        const clientToServer = new ChannelPrependTransform(streamIndex);
        this.upstreamChannels.next(clientToServer.readable);
        return clientToServer.writable;
      }),
      readable: maybe(opts.readable, () => {
        const serverToClient = new TransformStream<Uint8Array, Uint8Array>();
        this.downstreamChannels.set(streamIndex, serverToClient.writable.getWriter());
        return serverToClient.readable;
      }),
    });
  }

  ready(): Promise<void> {
    // We don't let the user create more channels after they call Ready.
    // (So why did we overengineer the stream merger?)
    // this.upstreamChannels.next(EOF);
    return Promise.resolve();
  }

  stop() {
    this.wss.close();
    return Promise.resolve();
  }
}

function maybe<Tcond extends boolean, Tres>(cond: Tcond, factory: () => Tres) {
  return (cond ? factory() : null) as (Tcond extends true ? Tres : null);
}

class ChannelPrependTransform extends TransformStream<Uint8Array, Uint8Array> {
  constructor(channelOctet: number) {
    super({
      transform(chunk, ctlr) {
        const buf = new ArrayBuffer(chunk.byteLength + 1);
        new DataView(buf).setUint8(0, channelOctet);
        const array = new Uint8Array(buf);
        array.set(chunk, 1);
        ctlr.enqueue(array);
      },
      // to implement proposed v5 of the tunnel protocol:
      // flush(ctlr) {
      //   ctlr.enqueue(new Uint8Array([255, channelOctet]));
      // },
    });
  }
}

/**
 * Merges all observables received from a Higher Order Observable
 * by emitting all items from all the observables.
 * Items are emitted in the order they appear.
 *
 * @typeparam T Type of items emitted by the observables.
 * @returns Transformer to consume observables and emit their collective items.
 */
function mergeAll<T>(): TransformStream<ReadableStream<T>> {
  const outChannel = new TransformStream<T>;
  const outWriter = outChannel.writable.getWriter();

  const forwarders = new Array<Promise<void>>;
  return {
    readable: outChannel.readable,
    writable: new WritableStream({
      write(observable) {
        const forwarder = observable
          .pipeTo(new WritableStream({
            async write(chunk) {
              await outWriter.write(chunk);
            },
            async abort(reason) {
              await outWriter.abort(reason);
            },
          }));
        forwarders.push(forwarder);
      },
      async abort(reason) {
        await outWriter.abort(reason);
      },
      async close() {
        try {
          await Promise.all(forwarders);
        } finally {
          outWriter.close();
        }
      },
    }, { highWaterMark: 1 }),
  };
}
