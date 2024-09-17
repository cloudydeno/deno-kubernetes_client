#!/usr/bin/env -S deno run --unstable-net --allow-env --allow-read --allow-net --cert=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt

import { WebsocketRestClient } from "../via-websocket.ts";

const client = await WebsocketRestClient.forInCluster();

const querystring = new URLSearchParams();
querystring.append('command', 'uptime');
querystring.set('container', 'nginx');
querystring.set('stdout', 'true');
querystring.set('stderr', 'true');

const tunnel = await client.performRequest({
  method: 'POST',
  path: `/api/v1/namespaces/${'dagd'}/pods/${'dagd-app-b9c856dd7-sklx5'}/exec`,
  querystring,
  expectTunnel: ['v4.channel.k8s.io'],
});

const stdout = await tunnel.getChannel({
  streamIndex: 1,
  readable: true,
  writable: false,
}).then(x => x.readable);

const stderr = await tunnel.getChannel({
  streamIndex: 2,
  readable: true,
  writable: false,
}).then(x => x.readable);

const status = await tunnel.getChannel({
  streamIndex: 3,
  readable: true,
  writable: false,
}).then(x => x.readable);
await tunnel.ready();

const [statusJson] = await Promise.all([
  new Response(status).json(),
  stdout.pipeTo(Deno.stdout.writable, { preventClose: true }),
  stderr.pipeTo(Deno.stderr.writable, { preventClose: true }),
]);
console.error(statusJson);
