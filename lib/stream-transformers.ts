import { JSONObject, WatchEvent } from './contract.ts';

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


/** Parses the first byte off of Blobs for wsstream purposes */
export class TaggedStreamTransformer extends TransformStream<Blob, [number,Uint8Array]> {
  constructor(config?: QueuingStrategy<Blob>) {
    super({
      async transform(raw, controller) {
        const data = new Uint8Array(await raw.arrayBuffer());
        controller.enqueue([data[0], data.slice(1)]);
      },
    }, config);
  }
}
