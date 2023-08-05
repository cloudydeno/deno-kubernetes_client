// The API contract that all generated code expects

export type HttpMethods =
  | "GET"
  | "POST"
  | "DELETE"
  | "PUT"
  | "PATCH"
  | "OPTIONS"
  | "HEAD";

export interface RequestOptions {
  method: HttpMethods;
  path: string;
  querystring?: URLSearchParams;
  abortSignal?: AbortSignal;

  contentType?: string;
  bodyRaw?: Uint8Array;
  bodyJson?: JSONValue;
  bodyStream?: ReadableStream<Uint8Array>;

  accept?: string;
  expectTunnel?: string[];
  expectStream?: boolean;
  expectJson?: boolean;
}

export interface KubernetesTunnel {
  /** Indicates which network protocol is in use.
   * This changes semantics, largely due to Kubernetes tunnel API quirks. */
  readonly transportProtocol: 'SPDY' | 'WebSocket' | 'Opaque';
  readonly subProtocol: string;
  /** Set up a channel, using either SPDY or Websocket semantics. */
  getChannel<
    Treadable extends boolean,
    Twritable extends boolean,
  >(opts: {
    // Different transports identify streams different ways
    spdyHeaders?: Record<string,string | number>;
    streamIndex?: number;
    // What streams should be hooked up
    readable: Treadable;
    writable: Twritable;
  }): Promise<{
    // close(): Promise<void>;
    readable: Treadable extends true ? ReadableStream<Uint8Array> : null;
    writable: Twritable extends true ? WritableStream<Uint8Array> : null;
  }>;
  /** Call once after creating the initial channels. */
  ready(): Promise<void>;
  /** Disconnects the underlying transport. */
  disconnect(): Promise<void>;
}

export interface RestClient {
  performRequest(opts: RequestOptions & {expectTunnel: string[]}): Promise<KubernetesTunnel>;
  performRequest(opts: RequestOptions & {expectStream: true; expectJson: true}): Promise<ReadableStream<JSONValue>>;
  performRequest(opts: RequestOptions & {expectStream: true}): Promise<ReadableStream<Uint8Array>>;
  performRequest(opts: RequestOptions & {expectJson: true}): Promise<JSONValue>;
  performRequest(opts: RequestOptions): Promise<Uint8Array>;
  defaultNamespace?: string;
}

// Structures that JSON can encode directly
export type JSONPrimitive = string | number | boolean | null | undefined;
export type JSONValue = JSONPrimitive | JSONObject | JSONArray;
export type JSONObject = {[key: string]: JSONValue};
export type JSONArray = JSONValue[];

// Constraint for when these fields will surely be present
export type ApiKind = {
  apiVersion: string;
  kind: string;
}

// Types seen in a resource watch stream
export type WatchEvent<T,U> = WatchEventObject<T> | WatchEventError<U> | WatchEventBookmark;
export type WatchEventObject<T> = {
  'type': "ADDED" | "MODIFIED" | "DELETED";
  'object': T;
};
export type WatchEventError<U> = {
  'type': "ERROR";
  'object': U;
};
export type WatchEventBookmark = {
  'type': "BOOKMARK";
  'object': { metadata: { resourceVersion: string }};
};
