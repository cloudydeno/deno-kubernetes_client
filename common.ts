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

  bodyRaw?: Uint8Array;
  bodyJson?: JSONValue;
  bodyStream?: ReadableStream<Uint8Array>;

  accept?: string;
  expectStream?: boolean;
  expectJson?: boolean;
}

export interface RestClient {
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
