#!/usr/bin/env -S deno run --unstable --allow-env --allow-read --allow-net
import { RestClient } from "../../lib/contract.ts";
import { WebsocketRestClient } from "../via-websocket.ts";
import { SpdyEnabledRestClient } from "./via-spdy-transport.ts";

async function streamPodLog(client: RestClient, namespace: string, name: string, opts: {
  container?: string;
  follow?: boolean;
  insecureSkipTLSVerifyBackend?: boolean;
  limitBytes?: number;
  previous?: boolean;
  sinceSeconds?: number;
  tailLines?: number;
  timestamps?: boolean;
  abortSignal?: AbortSignal;
} = {}) {
  const query = new URLSearchParams;
  if (opts["container"] != null) query.append("container", opts["container"]);
  if (opts["follow"] != null) query.append("follow", opts["follow"] ? '1' : '0');
  if (opts["insecureSkipTLSVerifyBackend"] != null) query.append("insecureSkipTLSVerifyBackend", opts["insecureSkipTLSVerifyBackend"] ? '1' : '0');
  if (opts["limitBytes"] != null) query.append("limitBytes", String(opts["limitBytes"]));
  if (opts["previous"] != null) query.append("previous", opts["previous"] ? '1' : '0');
  if (opts["sinceSeconds"] != null) query.append("sinceSeconds", String(opts["sinceSeconds"]));
  if (opts["tailLines"] != null) query.append("tailLines", String(opts["tailLines"]));
  if (opts["timestamps"] != null) query.append("timestamps", opts["timestamps"] ? '1' : '0');
  const tunnel = await client.performRequest({
    method: "GET",
    path: `/api/v1/namespaces/${namespace}/pods/${name}/log`,
    expectTunnel: ['binary.k8s.io'],
    querystring: query,
    abortSignal: opts.abortSignal,
  });
  const mainStream = await tunnel.getChannel({
    readable: true,
    writable: false,
    streamIndex: 0,
  });
  return mainStream.readable//;.pipeThrough(new TextDecoderStream('utf-8'));

}


// Load Kubernetes client configuration (auth, etc)
// const client = await WebsocketRestClient.forInCluster();
const client = await SpdyEnabledRestClient.forInCluster();

// Establish tunneled SPDY connection to a particular Pod's kubelet
const tunnel = await streamPodLog(client, 'dagd', 'dagd-app-b9c856dd7-sklx5', {
  container: 'nginx',
  timestamps: true,
});

// Hook up streams to the TTY
await tunnel.pipeTo(Deno.stdout.writable, { preventClose: true });
