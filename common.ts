// The API contract that all generated code expects

export type HttpMethods =
  | "get"
  | "post"
  | "delete"
  | "put"
  | "patch"
  | "options"
  | "head";

export interface RequestOptions {
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
  performRequest(method: HttpMethods, path: string, opts: RequestOptions & {expectStream: true; expectJson: true}): Promise<ReadableStream<JSONValue>>;
  performRequest(method: HttpMethods, path: string, opts: RequestOptions & {expectStream: true}): Promise<ReadableStream<Uint8Array>>;
  performRequest(method: HttpMethods, path: string, opts: RequestOptions & {expectJson: true}): Promise<JSONValue>;
  performRequest(method: HttpMethods, path: string, opts?: RequestOptions): Promise<Uint8Array>;
  defaultNamespace?: string;
}

// Things that JSON can encode directly
export type JSONPrimitive = string | number | boolean | null | undefined;
export type JSONValue = JSONPrimitive | JSONObject | JSONArray;
export type JSONObject = {[key: string]: JSONValue};
export type JSONArray = JSONValue[];
