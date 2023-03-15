#!/usr/bin/env -S deno run --unstable --allow-env

import { autoDetectClient } from '../mod.ts';

const client = await autoDetectClient();

// Stream multiple JSON objects for a Watch operation
for await (const line of await client.performRequest({
  method: 'GET',
  path: `/api/v1/namespaces/default/endpoints`,
  expectStream: true,
  expectJson: true,
  querystring: new URLSearchParams({
    watch: '1',
    timeoutSeconds: '5',
  }),
})) {
  console.log(line);
}

console.log('done');
