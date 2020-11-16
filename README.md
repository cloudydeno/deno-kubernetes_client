![Deno CI](https://github.com/danopia/deno-kubernetes_client/workflows/Deno%20CI/badge.svg?branch=main)

# `/x/kubernetes_client`

This module implements several ways of sending authenticated requests
to the Kubernetes API from deno scripts.

Kubernetes is a complex architechure which likes using sophisticated networking concepts,
while Deno is a relatively young runtime, so there's some mismatch in capabilities.
Therefor each included client has different notes and required flags in order to operate.

This library is intended as a building block.
If you are unsure how to issue a specific request from your own library/code,
please feel free to file a Github Issue.

## Usage

Here's a basic request, listing all Pods in the `default` namespace.
It uses the `autoDetectClient()` entrypoint which returns the first usable client.

```ts
import { autoDetectClient } from 'https://deno.land/x/kubernetes_client/mod.ts';
const kubernetes = await autoDetectClient();

const podList = await kubernetes.performRequest({
  method: 'GET',
  path: `/api/v1/namespaces/default/pods`,
  expectJson: true, // run JSON.parse on the response body
});
console.log(podList);

// see demo.ts for more request examples (streaming responses, etc)
```

To get started on local development, the easiest method is to call out to your `kubectl`
installation to make all the network calls.
This only requires the `--allow-run` Deno flag.
For deploying code into a cluster, more flags are necesary; see "Stable clients".

Check out `common.ts` to see the type/API contract.

## Changelog

* `v0.1.0` on `2020-11-16`: Initial publication, with KubectlRaw and InCluster clients.
    Also includes ReadableStream transformers, useful for consuming watch streams.

# Stable clients

* `KubectlRawRestClient` invokes `kubectl --raw` for every HTTP call.
    Excellent for development, though some features are not possible to implement.
    Flags: `--allow-run`
* `InClusterRestClient` uses a pod's ServiceAccount to automatically authenticate.
    This is what you'll use when you deploy your script to a cluster.
    Flags: `--allow-read --allow-net --cert=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt` (check )

Incomplete clients:

* `KubectlProxyRestClient` expects a `kubectl proxy` command to be running.
    This allows a full range-of-motion for development purposes.

## Unstable Clients

There are a few client strategies that currently require `--unstable`;
they all live in an `unstable/` folder for now and will hopefully someday
be able to get promoted out and fixed up at the same time.

None of these are complete at this time.

* `InClusterUnstableRestClient`: like the stable version, but uses Deno APIs to set the CA trust explicitly.
* `KubeConfigRestClient`: interprets the user's `~/.kube/config` and tries to talk to the cluster directly.
    This requires a lot of flags and unstable APIs at this time.
* `PluginRestClient`: Just a thought at this point.
    Could use a proper Rust Kubernetes client and compile it into a Deno plugin.

## Related: API Typings

This module is only implementing the HTTP/transport part of talking to Kubernetes.
You'll likely also want Typescript interfaces around actually working with Kubernetes resources.

API typings are being tracked in a sibling project:
[kubernetes_apis](https://github.com/danopia/deno-kubernetes_apis)
