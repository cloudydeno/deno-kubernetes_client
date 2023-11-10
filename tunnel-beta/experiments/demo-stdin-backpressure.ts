#!/usr/bin/env -S deno run --unstable --allow-env --allow-read --allow-net
import { execUsing } from "./run-exec.ts";
import { SpdyEnabledRestClient } from "./via-spdy-transport.ts";
import { WebsocketRestClient } from "../via-websocket.ts";
import { fromGenerator } from "https://deno.land/x/stream_observables@v1.3/sources/from-generator.ts";
import { repeat } from "https://deno.land/x/stream_observables@v1.3/sources/repeat.ts";
import { map } from "https://deno.land/x/stream_observables@v1.3/mod.ts";

// Load Kubernetes client configuration (auth, etc)
const client = await WebsocketRestClient.forInCluster();
// const client = await SpdyEnabledRestClient.forInCluster();

// Establish tunneled SPDY connection to a particular Pod's kubelet
const tunnel = await execUsing(client, {
  namespace: 'dagd',
  podName: 'dagd-app-b9c856dd7-sklx5',
  container: 'nginx',
  command: ['sh', '-euc', 'while true; do read x; if [ "$x" = baz ]; then echo $x; fi; done'],
  stdin: true,
  stdout: true,
  stderr: true,
});

// Hook up streams to the TTY
let count = 0;
await Promise.all([
  repeat('hello world\n')
    .pipeThrough(map(x => {
      count++;
      if (count % 500 == 0) {
        console.log(count);
        return 'baz\n';
      }
      return x
    }))
    .pipeThrough(new TextEncoderStream())
    .pipeTo(tunnel.stdin),
  tunnel.stdout.pipeTo(Deno.stdout.writable, { preventClose: true }),
  tunnel.stderr.pipeTo(Deno.stderr.writable, { preventClose: true }),
]);
console.error(await tunnel.status);
