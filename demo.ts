#!/usr/bin/env -S deno run --unstable

import { TextLineStream } from './deps.ts';
import { autoDetectClient } from './mod.ts';

const client = await autoDetectClient();

// Grab a single resource as JSON
console.log(await client.performRequest({
  method: 'GET',
  path: `/api/v1/namespaces/default/endpoints`,
  expectJson: true,
  querystring: new URLSearchParams({
    limit: '1',
  }),
}));

// Stream multiple JSON objects for a Watch operation
for await (const line of await client.performRequest({
  method: 'GET',
  path: `/api/v1/namespaces/default/endpoints`,
  expectStream: true,
  expectJson: true,
  querystring: new URLSearchParams({
    watch: '1',
    timeoutSeconds: '1',
  }),
})) {
  console.log(line);
}

// Stream plaintext log lines from a pod
const lineStream = await client.performRequest({
  method: 'GET',
  path: `/api/v1/namespaces/default/pods/lambdabot-0/log`,
  expectStream: true,
  querystring: new URLSearchParams({
    timestamps: '1',
    tailLines: '15',
  }),
}).then(x => x
  .pipeThrough(new TextDecoderStream('utf-8'))
  .pipeThrough(new TextLineStream()));
for await (const line of lineStream) {
  console.log(line);
}

console.log('done');
