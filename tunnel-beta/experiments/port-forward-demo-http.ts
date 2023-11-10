#!/usr/bin/env -S deno run --unstable --allow-env --allow-read --allow-net

// setTimeout(Deno.exit, 5000);

import { SpdyEnabledRestClient } from "./via-spdy-transport.ts";
import { PortForwardTunnel } from "./run-port-forward.ts";
import { WebsocketRestClient } from "../via-websocket.ts";

const client = await WebsocketRestClient.forInCluster();
// const client = await SpdyEnabledRestClient.forInCluster();

// Establish tunneled SPDY connection to a particular Pod's kubelet
const tunnel = await PortForwardTunnel.connectUsing(client, {
  namespace: 'dagd',
  podName: 'dagd-app-b9c856dd7-sklx5',
});

async function httpInteraction(path: string) {
  const {stream, result} = await tunnel.connectToPort(80);

  const writer = stream.writable.getWriter();
  await writer.write(new TextEncoder().encode(
  `GET ${path} HTTP/1.1
Host: localhost:8000
Connection: close
Accept: */*

`.replaceAll('\n', '\r\n')))
  await writer.close()
  console.error("Wrote request")

  return await new Response(stream.readable).text();
}

const resps = await Promise.all([
  httpInteraction('/ip'),
  httpInteraction('/ip'),
  httpInteraction('/ip'),
]);
console.error(resps)

console.error('Disconnecting...');
tunnel.disconnect()
