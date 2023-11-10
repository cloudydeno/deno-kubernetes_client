#!/usr/bin/env -S deno run --unstable --allow-env --allow-read --allow-net
import { execUsing } from "./run-exec.ts";
import { SpdyEnabledRestClient } from "./via-spdy-transport.ts";
import { WebsocketRestClient } from "../via-websocket.ts";
import { merge } from "https://deno.land/x/stream_observables@v1.3/combiners/merge.ts"

// Load Kubernetes client configuration (auth, etc)
const client = await WebsocketRestClient.forInCluster();
// const client = await SpdyEnabledRestClient.forInCluster();

// Establish tunneled connection to a particular Pod's kubelet
const tunnel = await execUsing(client, {
  namespace: 'dagd',
  podName: 'dagd-app-b9c856dd7-sklx5',
  container: 'nginx',
  command: ['sh', '-i'],
  stdin: true,
  stdout: true,
  stderr: true,
  tty: true,
});

const promises: Promise<unknown>[] = [
  tunnel.stdout.pipeTo(Deno.stdout.writable, { preventClose: true }),
  tunnel.stderr.pipeTo(Deno.stderr.writable, { preventClose: true }),
];

if (tunnel.resize) { // We want to hook up the raw TTY
  Deno.stdin.setRaw(true, { cbreak: true });
  const termSize = Deno.consoleSize();
  const sizeWriter = tunnel.resize.getWriter();
  sizeWriter.write({
    Width: termSize.columns,
    Height: termSize.rows,
  });
  sizeWriter.close();

  const interruptBuffer = new Uint8Array([0x03]);
  const ctrlC = new TransformStream<void,Uint8Array>({
    transform: (_, ctlr) => ctlr.enqueue(interruptBuffer),
  });
  const ctrlCwriter = ctrlC.writable.getWriter();
  const signalHandler = () => ctrlCwriter.write();
  Deno.addSignalListener('SIGINT', signalHandler);
  tunnel.status.finally(() => {
    Deno.removeSignalListener('SIGINT', signalHandler);
    ctrlCwriter.close();
    Deno.stdin.setRaw(false);
  });

  merge(ctrlC.readable, Deno.stdin.readable).pipeTo(tunnel.stdin);
} else if (tunnel.stdin) {
  Deno.stdin.readable.pipeTo(tunnel.stdin);
}

await Promise.race([
  tunnel.status,
  ...promises,
]);

const status = await tunnel.status;
if (status.reason == 'NonZeroExitCode') {
  const code = status.details?.causes.find(x => x.reason == 'ExitCode');
  if (code) {
    Deno.exit(parseInt(code.message));
  }
}
if (status.status == 'Success') {
  Deno.exit(0);
} else {
  console.error(status.message);
  Deno.exit(1);
}
