#!/usr/bin/env -S deno run --unstable --allow-env --allow-read --allow-net

import { SpdyEnabledRestClient } from "./via-spdy-transport.ts";
import { PortForwardTunnel } from "./run-port-forward.ts";

const client = await SpdyEnabledRestClient.forInCluster();

// Establish tunneled SPDY connection to a particular Pod's kubelet
const tunnel = await PortForwardTunnel.connectUsing(client, {
  namespace: 'dagd',
  podName: 'dagd-app-b9c856dd7-sklx5',
});

// Listen on a local port and relay connections thru the SPDY tunnel
tunnel.servePortforward({
  port: 8050,
  targetPort: 80,
});
console.error('Listening on http://localhost:8050');


// async function httpInteraction(port: number, path: string) {
//   const {stream, result} = await tunnel.connectToPort(port);

//   await new Promise(ok => setTimeout(ok, 2000))

//   const writer = stream.writable.getWriter();
//   await writer.write(new TextEncoder().encode(
//   `GET ${path} HTTP/1.1
// Host: localhost:8000
// Connection: close
// Accept: */*

// `.replaceAll('\n', '\r\n')))
//   await writer.close()
//   console.error("Wrote request")

//   return {
//     body: await new Response(stream.readable).text(),
//     result: await result,
//   }
// }

// const resps = await Promise.all([
//   httpInteraction(80, '/ip'),
//   httpInteraction(81, '/ip'),
//   httpInteraction(80, '/ip'),
// ]);
// console.error(resps)

// console.error(resp1);
// const resp2 = await httpInteraction(80, '/ip?cow');
// console.error(resp2);
// const resp3 = await httpInteraction(80, '/headers');
// console.error(resp3);

// const resp1 = await httpInteraction(81, '/ip');
// console.error(resp1);
// const resp2 = await httpInteraction(80, '/ip?cow');
// console.error(resp2);
// const resp3 = await httpInteraction(80, '/headers');
// console.error(resp3);

// console.error('Disconnecting...');
// tunnel.disconnect()
