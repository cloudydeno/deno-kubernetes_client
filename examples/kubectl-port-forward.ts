#!/usr/bin/env -S deno run --allow-run=kubectl --no-prompt

// This libary does not implement Kubernetes port-forwarding.
// If you would like to serve ports on localhost that proxy to a pod,
// you can launch `kubectl port-forward` as a child process to handle this.
// This example shows how you might run specific kubectl commands.

import { TextLineStream } from '../deps.ts';
import { KubectlRawRestClient } from "../mod.ts";

const client = new KubectlRawRestClient();

// Process arguments
const [ namespace, podNamePrefix, ...portForwardSpec ] = Deno.args;
if (!namespace || !podNamePrefix || !portForwardSpec.length) {
  console.error(`Usage:\n\tkubectl-port-forward.ts <namespace> <pod-name-prefix> <...port-forward-spec>`);
  console.error(`Example:\n\tkubectl-port-forward.ts default my-deployment- 5000:80`);
  Deno.exit(5);
}

// Find the first matching pod
// This would be easier with https://deno.land/x/kubernetes_apis
const podList = await client.performRequest({
  method: 'GET',
  path: `/api/v1/namespaces/${namespace}/pods`,
  expectJson: true,
}) as { items: Array<{ metadata: { name: string } }> };
const podName = podList.items
  .map(x => x.metadata.name)
  .find(name => name.startsWith(podNamePrefix));
if (!podName) {
  console.error(`No pod found in ${namespace} with name prefix ${podNamePrefix}`);
  Deno.exit(1);
}

// Spin up kubectl port-forward
console.log('Forwarding to pod', podName);
const [process, status] = await client.runKubectl([
  'port-forward',
  '-n', namespace,
  '--',
  podName,
  ...portForwardSpec,
], {});
status.then(status => {
  if (status.code !== 0) {
    console.error(`WARN: Failed to call kubectl port-forward: code ${status.code}`);
  }
});

// Copy output lines (port-forward progress) to stderr
for await (const line of process.stdout
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream())) {
  console.error('kubectl says:', line);
}
