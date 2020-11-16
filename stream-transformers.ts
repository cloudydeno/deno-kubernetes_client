import { JSONObject, WatchEvent } from "./common.ts";

class TextLineReader {
  decoder: TextDecoder;
  buffers = new Array<Uint8Array>();
  constructor(decoder: TextDecoder) {
    this.decoder = decoder;
  }
  processChunk(chunk: Uint8Array, controller: TransformStreamDefaultController<string>) {
    // If we reached the end of a line that spans chunks, join them all together
    if (chunk.includes(10) && this.buffers.length > 0) {
      const indexOfNl = chunk.indexOf(10);
      const fullBuf = this.concatWaitingBuffersWith(chunk.subarray(0, indexOfNl));
      controller.enqueue(this.decoder.decode(fullBuf));
      chunk = chunk.subarray(indexOfNl + 1);
    }

    // process all remaining lines fully contained within this chunk
    let indexOfNl = 0;
    while ((indexOfNl = chunk.indexOf(10)) >= 0) {
      controller.enqueue(this.decoder.decode(chunk.subarray(0, indexOfNl)));
      chunk = chunk.subarray(indexOfNl + 1);
    }

    // keep any leftover for next time
    if (chunk.length > 0) {
      // make a copy because Deno.iter reuses its buffer
      this.buffers.push(new Uint8Array(chunk));
    }
  }
  concatWaitingBuffersWith(latest: Uint8Array): Uint8Array {
    const fullLength = this.buffers.reduce((len, buf) => len+buf.byteLength, latest.byteLength);
    // force preventative maintanence on growing line usecases
    if (fullLength > 5*1024*1024) {
      throw new Error(`Received a single streamed line longer than 5MiB, selfishly giving up`);
    }

    // build a concatted buffer
    const fullBuf = new Uint8Array(fullLength);
    let idx = 0;
    for (const buf of this.buffers) {
      fullBuf.set(buf, idx);
      idx += buf.byteLength;
    }
    fullBuf.set(latest, idx);

    // finish up
    this.buffers.length = 0;
    return fullBuf;
  }
}

/** Reassembles newline-deliminited data from byte chunks into decoded text strings */
export class ReadLineTransformer extends TransformStream<Uint8Array, string> {
  constructor(encoding = 'utf-8') {
    const reader = new TextLineReader(new TextDecoder(encoding));
    super({ transform: reader.processChunk.bind(reader) });
  }
}


function parseJsonLine(line: string, controller: TransformStreamDefaultController<JSONObject>) {
  if (!line.startsWith('{')) {
    throw new Error(`JSON line doesn't start with {: `+line.slice(0, 256));
  }
  controller.enqueue(JSON.parse(line));
}

/** Parses individual JSON objects from individual strings, 1:1 */
export class JsonParsingTransformer extends TransformStream<string, JSONObject> {
  constructor() {
    super({ transform: parseJsonLine });
  }
}


// context: https://github.com/denoland/deno/pull/8378

export function readableStreamFromAsyncIterator<T>(
  iterator: AsyncIterableIterator<T>,
  cancel?: ReadableStreamErrorCallback,
): ReadableStream<T> {
  return new ReadableStream({
    cancel,
    async pull(controller) {
      const { value, done } = await iterator.next();

      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
  });
}

export function readableStreamFromReaderCloser(
  source: Deno.Reader & Deno.Closer,
  options?: {
    bufSize?: number;
  },
): ReadableStream<Uint8Array> {
  return readableStreamFromAsyncIterator(
    Deno.iter(source, options),
    () => source.close(),
  );
}


class WatchEventReader<T,U> {
  objValidator: (val: JSONObject) => T;
  errValidator: (val: JSONObject) => U;
  constructor(objValidator: (val: JSONObject) => T, errValidator: (val: JSONObject) => U) {
    this.objValidator = objValidator;
    this.errValidator = errValidator;
  }
  processObject(raw: JSONObject, controller: TransformStreamDefaultController<WatchEvent<T,U>>) {
    const {type, object} = raw;
    if (typeof type !== 'string') {
      throw new Error(`BUG: watch record 'type' field was ${typeof type}`);
    }
    if (object == null) {
      throw new Error(`BUG: watch record 'object' field was null`);
    }
    if (typeof object !== 'object') {
      throw new Error(`BUG: watch record 'object' field was ${typeof object}`);
    }
    if (Array.isArray(object)) {
      throw new Error(`BUG: watch record 'object' field was Array`);
    }

    switch (type) {
      case 'ERROR':
        controller.enqueue({type, object: this.errValidator(object)});
        break;
      case 'ADDED':
      case 'MODIFIED':
      case 'DELETED':
        controller.enqueue({type, object: this.objValidator(object)});
        break;
      case 'BOOKMARK':
        if (object.metadata && typeof object.metadata === 'object' && !Array.isArray(object.metadata)) {
          if (typeof object.metadata.resourceVersion === 'string') {
            controller.enqueue({type, object: {
              metadata: { resourceVersion: object.metadata.resourceVersion },
            }});
            break;
          }
        }
        throw new Error(`BUG: BOOKMARK event wasn't recognizable: ${JSON.stringify(object)}`);
      default:
        throw new Error(`BUG: watch record got unknown event type ${type}`);
    }
  }
}

/** Validates JSON objects belonging to a watch stream */
export class WatchEventTransformer<T,U> extends TransformStream<JSONObject, WatchEvent<T,U>> {
  constructor(objValidator: (val: JSONObject) => T, errValidator: (val: JSONObject) => U) {
    const reader = new WatchEventReader(objValidator, errValidator);
    super({ transform: reader.processObject.bind(reader) });
  }
}
