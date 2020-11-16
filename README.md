# kubernetes_client

This module implements several ways of sending authenticated requests
to the Kubernetes API from deno scripts.

Kubernetes is a complex architechure which likes using sophisticated networking concepts,
while Deno is a relatively young runtime, so there's some mismatch in capabilities.
Therefor each included client has different notes and required flags in order to operate.

## Usage

To get started on local development, the easiest method is to call out to your `kubectl`
installation to make all the network calls.
This only requires `--allow-run` using `via-kubectl-raw.ts`.
For deploying code into a cluster, more flags are necesary; see `via-incluster.ts`.

`demo.ts` shows how to make different types of API requests with any client.
It uses the `autoDetectClient()` entrypoint which returns the first working client.

## Unstable Clients

There are a few client strategies that currently require `--unstable`;
they all live in an `unstable/` folder for now and will hopefully someday
be able to get promoted out and fixed up at the same time.

## API Typings

This module is only implementing the HTTP/transport part of talking to Kubernetes.
You'll likely also want Typescript interfaces around actually working with Kubernetes resources.

API typings are being tracked in a sibling project:
[kubernetes_apis](https://github.com/danopia/deno-kubernetes_apis)
