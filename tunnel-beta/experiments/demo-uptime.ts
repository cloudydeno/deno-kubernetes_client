#!/usr/bin/env -S deno run --unstable --allow-env --allow-read --allow-net
import { execUsing } from "./run-exec.ts";
import { SpdyEnabledRestClient } from "./via-spdy-transport.ts";
import { WebsocketRestClient } from "../via-websocket.ts";

// Load Kubernetes client configuration (auth, etc)
const client = await WebsocketRestClient.forInCluster();
// const client = await SpdyEnabledRestClient.forInCluster();

// Establish tunneled SPDY connection to a particular Pod's kubelet
const tunnel = await execUsing(client, {
  namespace: 'dagd',
  podName: 'dagd-app-b9c856dd7-sklx5',
  container: 'nginx',
  command: ['uptime'],
  stdout: true,
  stderr: true,
});

// Hook up streams to the TTY
await Promise.all([
  tunnel.stdout.pipeTo(Deno.stdout.writable, { preventClose: true }),
  tunnel.stderr.pipeTo(Deno.stderr.writable, { preventClose: true }),
]);
console.error(await tunnel.status);
