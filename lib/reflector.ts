import { WatchEvent, WatchEventError, WatchEventBookmark } from './contract.ts';

/**
 * Implementation of a Kubernetes List/Watch client which furnishes a view of the watched data.
 * This is commonly called a 'Reflector' among the client libraries, though this one is less standard.

 * The core class here is a bit generic and tries to depend mostly on things within this file.
 * This is because a Reflector works pretty directly with Kubernetes API objects,
 * while this overall kubernetes_client module only serves as an API access path.
 * So you'll be furnishing your exact API structures by instiantiating the Reflector class.
 * (Usually the API will be from /x/kubernetes_apis/builtin/meta@v1/struct.ts but it can vary)
 *
 * This class/file work fine, but the types and APIs are still *unstable* while I figure out
 * what's necesary for various usecases.
 * Please file issues or start discussions if you have any input!
 */

// some of this should be centralized...
export type KindIds = { metadata?: {
  name?: string | null;
  namespace?: string | null;
  uid?: string | null;
  resourceVersion?: string | null;
} | null };
// inside our database, make sure we have the IDs
export type KindIdsReq = { metadata: {
  name: string;
  namespace?: string | null;
  uid: string;
  resourceVersion: string;
} };
type ListOf<T> = { metadata: { resourceVersion?: string | null }; items: Array<T> };
type ListOpts = { abortSignal?: AbortSignal, resourceVersion?: string; limit?: number; continue?: string };
type WatchOpts = { abortSignal?: AbortSignal, resourceVersion?: string; timeoutSeconds?: number; allowWatchBookmarks?: boolean };

type VersionRef = { metadata: { resourceVersion: string | null }}; // WeakMap key

// synthetic event to indicate that we have emitted a complete picture
type WatchEventSynced = {
  'type': "SYNCED";
  'object': VersionRef;
} | {
  'type': "DESYNCED";
  'object': {metadata: {}};
};
type WatchEventObject<T> = {
  'type': "ADDED" | "DELETED";
  'object': T;
};
type WatchEventModified<T> = {
  'type': "MODIFIED";
  'object': T;
  'previous': T;
};


export type ReflectorEvent<T,S=ApiStatus> =
| WatchEventObject<T & KindIdsReq>
| WatchEventModified<T & KindIdsReq>
| WatchEventError<S>
| WatchEventBookmark
| WatchEventSynced;
type NextEvent<T,S> = {evt: ReflectorEvent<T,S>, ref: VersionRef};

export interface ApiStatus {
  metadata?: { resourceVersion?: string | null } | null;
  code?: number | null;
  message?: string | null;
  reason?: string | null;
  status?: string | null;
}

export class Reflector<T extends KindIds, S extends ApiStatus> {
  #lister: (opts: ListOpts) => Promise<ListOf<T>>;
  #watcher: (opts: WatchOpts) => Promise<ReadableStream<WatchEvent<T,S>>>;
  constructor(lister: (opts: ListOpts) => Promise<ListOf<T>>, watcher: (opts: WatchOpts) => Promise<ReadableStream<WatchEvent<T,S>>>) {
    this.#lister = lister;
    this.#watcher = watcher;
  }

  #resources = new Map<string, T & KindIdsReq>();
  #latestVersion?: string;

  getCached(namespace: string, name: string): (T & KindIdsReq) | undefined {
    return this.#resources.get(`${namespace||''}/${name}`);
  }
  listCached(): Iterable<T & KindIdsReq> {
    return this.#resources.values();
  }
  isSynced(): boolean {
    return !!this.#latestVersion;
  }

  #cancelled = false;

  #nextEvents = new WeakMap<VersionRef, NextEvent<T,S>>(); // linked list i guess...
  #latestRef: VersionRef = {metadata: {resourceVersion: null}};

  #waitingCbs = new Array<() => void>();

  stop() {
    if (this.#cancelled) throw new Error(`BUG: double-cancel`);
    this.#cancelled = true;
    // if (this.#cancel) this.#cancel();

    this._emit({
      type: 'ERROR',
      object: {reason: "ReflectorStopped"} as S,
    }, null);

    throw new Error(`TODO: a ton of cleanup`);
  }

  _emit(evt: ReflectorEvent<T,S>, refVersion: string | null): void {
    // console.log('emitting', evt.type);
    const ref: VersionRef = {metadata: {resourceVersion: refVersion}};

    this.#nextEvents.set(this.#latestRef, {
      evt: evt,
      ref: ref,
    });
    this.#latestRef = ref;
    if (refVersion != null) {
      this.#latestVersion = refVersion;
    }

    // TODO: is this safe enough?
    for (const cb of this.#waitingCbs) {
      cb();
    }
    this.#waitingCbs.length = 0;
    // throw new Error(`TODO`);
    // console.log('emitted', evt.type, refVersion);
  }

  // main thread running the whole Reflector show
  // tries to return cleanly if reflector is cancelled
  // TODO: if this crashes, crash every consumer too
  async run(abortSignal?: AbortSignal) {
    if (abortSignal) {
      if (abortSignal.aborted) return;
      abortSignal.addEventListener('abort', () => this.stop());
    }

    while (!this.#cancelled) {
      const listFrom = this.#latestVersion || "0";
      const missingItems = new Map(this.#resources);

      const list = await this.#lister({resourceVersion: listFrom, abortSignal});
      if (!list.metadata.resourceVersion) throw new Error(`BUG: list had no version`);
      const listVer = list.metadata.resourceVersion;

      for (const item of list.items) {
        if (!isKeyed(item)) throw new Error(`BUG: got unkeyed item from list ${listVer}`);

        const key = `${item.metadata.namespace}/${item.metadata.name}`;
        const known = this.#resources.get(key);
        if (known) {
          missingItems.delete(key);
          if (known.metadata.resourceVersion !== item.metadata.resourceVersion) {
            this.#resources.set(key, item);
            this._emit({type: "MODIFIED", object: item, previous: known}, null);
          }
        } else {
          this.#resources.set(key, item);
          this._emit({type: "ADDED", object: item}, null);
        }
      }

      for (const [key, item] of missingItems) {
        this.#resources.delete(key);
        this._emit({type: "DELETED", object: item}, null);
      }

      this._emit({type: "SYNCED", object: {
        metadata: {resourceVersion: listVer}},
      }, listVer); // finally set this.#latestVersion

      // loop watching as long as our resourceVersion is valid
loop: while (!this.#cancelled) {
        const watch = await this.#watcher({
          resourceVersion: this.#latestVersion,
          allowWatchBookmarks: true,
          abortSignal,
        });
        for await (const evt of watch) {
          if (this.#cancelled) return;

          if (evt.type === 'ERROR') {
            // the only expected error is our resourceVersion being too old (might be others later)
            if (evt.object.reason === 'Expired') {
              console.log('Reflector watch expired, starting from clean resync');
              // don't even tell downstreams about the expiration
              // they'll be able to know via the DESYNCED event
              break loop;
            }

            this._emit(evt, null);
            console.log('TODO: reflector got error:', evt.object);
            // throw new Error(`TODO: handle reflector error`);
            this.stop(); // TODO: maybe stop WITH a status, always

          } else if (evt.type === 'BOOKMARK') {
            this._emit(evt, evt.object.metadata.resourceVersion);

          } else {
            if (!isKeyed(evt.object)) throw new Error(`BUG: got unkeyed item from watch ${evt.type}`);
            const {namespace, name, resourceVersion} = evt.object.metadata;
            const key = `${namespace}/${name}`;
            if (evt.type === 'DELETED') {
              this.#resources.delete(key);
              this._emit({type: evt.type, object: evt.object}, resourceVersion);
            } else if (evt.type === 'MODIFIED') {
              const previous = this.#resources.get(key);
              this.#resources.set(key, evt.object);
              if (!previous) {
                console.log(`WARN: Reflector got MODIFIED for ${key} but didn't have existing item`);
                this._emit({type: 'ADDED', object: evt.object}, resourceVersion);
              } else {
                this._emit({type: evt.type, object: evt.object, previous}, resourceVersion);
              }
            } else {
              this.#resources.set(key, evt.object);
              this._emit({type: evt.type, object: evt.object}, resourceVersion);
            }
          }

        }
      }
      if (this.#cancelled) return;

      // indicate that we're no longer contiguous
      this._emit({type: "DESYNCED", object: {
        metadata: {}},
      }, ""); // clear latest version
    }
  }

  async *observeAll(): AsyncIterableIterator<ReflectorEvent<T,S>> {
    // take snapshots for consistent state
    const knownVer = this.#latestVersion;
    const knownRef = this.#latestRef;
    const startupBurst = Array.from(this.#resources.values());

    // send what we already knew
    // console.log('refobs startup burst:', startupBurst.length)
    for (const item of startupBurst) {
      yield {type: "ADDED", object: item};
    }

    if (knownVer) {
      yield {type: "SYNCED", object: {metadata: {resourceVersion: knownVer }}};
    }

    // cycle between catching up and being up-to-date/waiting forever

    let ref = knownRef;
    while (true) {
      // send all pending events
      // console.log('refobs flushing from', ref);
      let next: NextEvent<T,S> | undefined;
      while (next = this.#nextEvents.get(ref)) {
        // console.log('refobs got', next.evt.type, next.ref)
        yield next.evt;
        if (next.evt.type === 'ERROR') {
          throw new Error(`Reflector gave us an ERROR`);
        }
        ref = next.ref;
      }

      // wait for new events
      // console.log('refobs waiting from', ref);
      await new Promise<void>(ok => this.#waitingCbs.push(ok));
    }
  }

  goObserveAll<U>(cb: (iter: AsyncIterableIterator<ReflectorEvent<T,S>>) => Promise<U>): Promise<U> {
    return cb(this.observeAll());
  }
}

function isKeyed<T>(item: T & KindIds): item is T & KindIdsReq {
  return !!item.metadata
    && item.metadata.name != null
    && item.metadata.resourceVersion != null
    && item.metadata.uid != null;
}
