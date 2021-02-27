![Deno CI](https://github.com/danopia/deno-kubernetes_client/workflows/Deno%20CI/badge.svg?branch=main)

# `/x/kubernetes_client`

This module implements several ways of sending authenticated requests
to the Kubernetes API from deno scripts.

Kubernetes is a complex architechure which likes using sophisticated networking concepts,
while Deno is a relatively young runtime, so there's some mismatch in capabilities.
Therefor one client implementation cannot work in every case,
and different Deno flags enable supporting different setups.

This library is intended as a building block.
If you are unsure how to issue a specific request from your own library/code,
or if your usage results in any `TODO: ...` error message from my code,
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

To get started on local development, `autoDetectClient` will most likely
decide to call out to your `kubectl`
installation to make each network call.
This only requires the `--allow-run` Deno flag.

To use other clients, more flags are necesary.
See "Client Implementations" below for more information on other clients.

The `kubectl` client logs the issued commands if `--verbose` is passed to the Deno program.

Check out `lib/contract.ts` to see the type/API contract.

## Changelog

* `v0.2.0` in `the future`: Rewrote KubeConfig handling and removed stable/unstable split.
    There's only two transport implementations now: KubectlRaw nad KubeConfig

* `v0.1.3` on `2020-12-29`: Improved `KubectlRaw` Patch support.
    Now supports namespaced resources ;) and knows that subresources can't be patched.

* `v0.1.2` on `2020-12-27`: Initial `KubectlRaw` Patch support.
    Also exports the `Reflector` implementation and plumbs the unstable `Kubeconfig` client more.

* `v0.1.1` on `2020-12-24`: Add a generic Reflector implementation.
    This is useful for consuming a pairing of list & watch APIs.

* `v0.1.0` on `2020-11-16`: Initial publication, with `KubectlRaw` and `InCluster` clients.
    Also includes `ReadableStream` transformers, useful for consuming watch streams.

# Client Implementations

An error message is shown when no client is usable, something like this:

```
Error: Failed to load any possible Kubernetes clients:
  - InCluster PermissionDenied: read access to "/var/run/secrets/kubernetes.io/serviceaccount/namespace", run again with the --allow-read flag
  - KubeConfig PermissionDenied: access to environment variables, run again with the --allow-env flag
  - KubectlProxy PermissionDenied: network access to "localhost:8001", run again with the --allow-net flag
  - KubectlRaw PermissionDenied: access to run a subprocess, run again with the --allow-run flag
```

Each client has different pros and cons:

* `KubectlRawRestClient` invokes `kubectl --raw` for every HTTP call.
    Excellent for development, though a couple APIs are not possible to implement.

    Flags: `--allow-run`

* `KubeConfigRestClient` uses Deno's `fetch()` to issue HTTP requests.
    There's a few different functions to configure it:

    * `forInCluster()` uses a pod's ServiceAccount to automatically authenticate.
        This is what is used when you deploy your script to a cluster.

        Flags: `--allow-read --allow-net` plus either `--unstable` or `--cert=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt`

    * `forKubectlProxy()` expects a `kubectl proxy` command to be running and talks directly to it without auth.

        This allows a full range-of-motion for development purposes regardless of the Kubernetes configuration.

        Flags: `--allow-net=localhost:8001` given that `kubectl proxy` is already running at that URL.

    * `readKubeConfig(path?)` (or `forKubeConfig(config)`) tries using the given config (or `$HOME/.kube/config` if none is given) as closely as possible.

        This requires a lot of flags depending on the config file, and in some cases simply cannot work. For example `https://<ip-address>` server values are not currently supported by Deno. Trial & error works here :)

        Entry-level flags: `--allow-env --allow-net --allow-read=$HOME/.kube`

## Related: API Typings

This module is only implementing the HTTP/transport part of talking to Kubernetes.
You'll likely also want Typescript interfaces around actually working with Kubernetes resources.

API typings are being tracked in a sibling project:
[kubernetes_apis](https://github.com/danopia/deno-kubernetes_apis)
published to
[/x/kubernetes_apis](https://deno.land/x/kubernetes_apis)

## TODO
* [x] Support for `kubectl proxy`
* [ ] Add filtering to Reflector implementation (e.g. by annotation)
