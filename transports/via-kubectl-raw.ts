import { RestClient, HttpMethods, RequestOptions } from '../common.ts';
import {
  JsonParsingTransformer, ReadLineTransformer,
  readableStreamFromReaderCloser,
} from "../stream-transformers.ts";

/**
 * A RestClient for easily running on a developer's local machine.
 * Your existing kubectl is called to do all the actual authentication and network stuff.
 * This is pretty reliable but mot all types of requests can be performed this way.
 *
 * Deno flags to use this client:
 *   --allow-run
 *
 * Pro: Any valid kubeconfig will be supported automatically :)
 * Con: In particular, these features aren't available:
 *   - Setting or receiving HTTP headers
 *   - HTTP methods such as PATCH and HEAD
 */

export class KubectlRawRestClient implements RestClient {
  namespace = undefined; // TODO: read from `kubectl config view --output=json`

  async performRequest(opts: RequestOptions): Promise<any> {
    const command = {
      GET: 'get',
      POST: 'create',
      DELETE: 'delete',
      PUT: 'replace',
      PATCH: '',
      OPTIONS: '',
      HEAD: '',
    }[opts.method];
    if (!command) throw new Error(`KubectlRawRestClient cannot perform HTTP ${opts.method}`);

    if (opts.abortSignal?.aborted) throw new Error(`Given AbortSignal is already aborted`);

    let path = opts.path || '/';
    const query = opts.querystring?.toString() ?? '';
    if (query) {
      path += (path.includes('?') ? '&' : '?') + query;
    }

    const hasReqBody = opts.bodyJson !== undefined || !!opts.bodyRaw || !!opts.bodyStream;
    console.error(opts.method, path, hasReqBody ? '(w/ body)' : '');

    const p = Deno.run({
      cmd: ["kubectl", command, ...(hasReqBody ? ['-f', '-'] : []), "--raw", path],
      stdin: hasReqBody ? 'piped' : undefined,
      stdout: "piped",
      stderr: "inherit",
    });
    const status = p.status();

    if (opts.abortSignal) {
      const abortHandler = () => {
        console.error('processing kubectl abort');
        p.stdout.close();
      };
      opts.abortSignal.addEventListener("abort", abortHandler);
      status.finally(() => {
        console.error('cleaning up abort handler');
        opts.abortSignal?.removeEventListener("abort", abortHandler);
      });
    }

    if (p.stdin) {
      if (opts.bodyStream) {
        const {stdin} = p;
        opts.bodyStream.pipeTo(new WritableStream({
          async write(chunk, controller) {
            await stdin.write(chunk).catch(err => controller.error(err));
          },
          close() {
            stdin.close();
          },
        }));
      } else if (opts.bodyRaw) {
        await p.stdin.write(opts.bodyRaw);
        p.stdin.close();
      } else {
        await p.stdin.write(new TextEncoder().encode(JSON.stringify(opts.bodyJson)));
        p.stdin.close();
      }
    }

    if (opts.expectStream) {
      status.then(status => {
        if (status.code !== 0) {
          console.error(`WARN: Failed to call kubectl streaming: code ${status.code}`);
        }
      });

      // with kubectl --raw, we don't really know if the stream is working or not
      //   until it exits (maybe bad) or prints to stdout (always good)
      // so let's wait to return the stream until the first read returns
      const stream = await new Promise<ReadableStream<Uint8Array>>((ok, err) => {
        let isFirstRead = true;
        const startTime = new Date;

        // Convert Deno.Reader|Deno.Closer into a ReadableStream (like 'fetch' gives)
        const stream = readableStreamFromReaderCloser({
          close: () => {
            p.stdout.close();
            // is this the most reliable way??
            Deno.run({cmd: ['kill', `${p.pid}`]});
          },
          // Intercept reads to try doing some error handling/mgmt
          read: async buf => {
            // do the read
            const num = await p.stdout.read(buf);

            // if we EOFd, check the process status
            if (num === null) {
              const stat = await status;
              // if it took multiple minutes to fail, probably just failed unrelated
              const delayMillis = new Date().valueOf() - startTime.valueOf();
              // TODO: some way of passing an error through the ReadableStream?
              if (stat.code !== 0 && delayMillis < 3*60*1000) {
                // might not be too late to fail the call more properly
                err(new Error(`kubectl stream ended with code ${stat.code}`));
                return num;
              }
              // if exit code was 0, let the EOF happen normally, below
            }

            // if we got our first data, resolve the original promise
            if (isFirstRead) {
              isFirstRead = false;
              ok(stream);
            }

            return num;
          },
        }, {bufSize: 8*1024}); // watch events tend to be pretty small I guess?
        // 'stream' gets passed to ok() to be returned
      });

      if (opts.expectJson) {
        return stream
          .pipeThrough(new ReadLineTransformer('utf-8'))
          .pipeThrough(new JsonParsingTransformer());
      } else {
        return stream;
      }
    }

    // not streaming, so download the whole response body
    const rawOutput = await p.output();
    const { code } = await status;
    if (code !== 0) {
      throw new Error(`Failed to call kubectl: code ${code}`);
    }

    if (opts.expectJson) {
      const data = new TextDecoder("utf-8").decode(rawOutput);
      return JSON.parse(data);
    } else {
      return rawOutput;
    }
  }

}
// export default KubectlRawRestClient;
