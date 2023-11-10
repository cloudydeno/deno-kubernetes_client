import { RestClient } from "../../lib/contract.ts";

export type ExecOptions = {
  namespace?: string;
  podName: string;
  container: string;
  command: string[];
  stdin?: boolean;
  stdout: boolean;
  stderr?: boolean;
  tty?: boolean;
};

export type ExecStreams<T extends ExecOptions> = {
  stdin: T['stdin'] extends true ? WritableStream<Uint8Array> : null;
  stdout: T['stdout'] extends true ? ReadableStream<Uint8Array> : null;
  stderr: T['stderr'] extends true ? ReadableStream<Uint8Array> : null;
  status: Promise<ExecStatus>;
  resize: T['tty'] extends true ? WritableStream<TerminalSize> : null;
}

export type TerminalSize = {
  Width: number;
  Height: number;
}

export type ExecStatus = {
  status: 'Success' | 'Failure';
  message?: string;
  reason?: string;
  details?: { causes: Array<{
    reason: string;
    message: string;
  }> };
  code?: number;
}

export async function execUsing<T extends ExecOptions>(client: RestClient, opts: T): Promise<ExecStreams<T>> {
  const querystring = new URLSearchParams();
  for (const command of opts.command) {
    querystring.append('command', command);
  }
  querystring.set('container', opts.container);

  if (opts.stdin) {
    querystring.set('stdin', 'true');
  }
  querystring.set('stdout', `${opts.stdout ?? true}`);
  if (opts.stderr) {
    querystring.set('stderr', 'true');
  }
  if (opts.tty) {
    querystring.set('tty', 'true');
  }

  const namespace = opts.namespace ?? client.defaultNamespace ?? 'default';
  const tunnel = await client.performRequest({
    method: 'POST',
    path: `/api/v1/namespaces/${namespace}/pods/${opts.podName}/exec`,
    querystring,
    expectTunnel: [
      // proposed v5: adds stdin closing
      'v4.channel.k8s.io', // v4: adds exit codes
      // v3: adds terminal resizing
      // v2: it works
      // v1: do not use
    ],
  });

  const [stdinStream, stdoutStream, stderrStream, errorStream, resizeStream] = await Promise.all([
    opts.stdin ? tunnel.getChannel({
      streamIndex: 0,
      spdyHeaders: {
        streamType: 'stdin',
      },
      readable: false,
      writable: true,
    }).then(x => x.writable) : null,
    opts.stdout ? tunnel.getChannel({
      streamIndex: 1,
      spdyHeaders: {
        streamType: 'stdout',
      },
      readable: true,
      writable: false,
    }).then(x => x.readable) : null,
    opts.stderr ? tunnel.getChannel({
      streamIndex: 2,
      spdyHeaders: {
        streamType: 'stderr',
      },
      readable: true,
      writable: false,
    }).then(x => x.readable) : null,
    tunnel.getChannel({
      streamIndex: 3,
      spdyHeaders: {
        streamType: 'error',
      },
      readable: true,
      writable: false,
    }),
    opts.tty ? tunnel.getChannel({
      streamIndex: 4,
      spdyHeaders: {
        streamType: 'resize',
      },
      readable: false,
      writable: true,
    }).then(x => x.writable) : null,
  ]);

  const statusPromise = new Response(errorStream.readable).json();
  statusPromise.finally(() => tunnel.stop());

  return {
    stdin:  maybe<T["stdin"],  WritableStream<Uint8Array>>(opts.stdin,  () => stdinStream!),
    stdout: maybe<T["stdout"], ReadableStream<Uint8Array>>(opts.stdout, () => stdoutStream!),
    stderr: maybe<T["stderr"], ReadableStream<Uint8Array>>(opts.stderr, () => stderrStream!),
    status: statusPromise,
    resize: maybe<T['tty'], WritableStream<TerminalSize>>(opts.tty, () => {
      const transformer = new TransformStream<TerminalSize, Uint8Array>({
        transform(chunk: TerminalSize, ctlr) {
          ctlr.enqueue(new TextEncoder().encode(JSON.stringify(chunk)));
        },
      });
      transformer.readable.pipeTo(resizeStream!);
      return transformer.writable;
    }),
  };
}

function maybe<Tcond extends boolean | undefined, Tres>(cond: Tcond, factory: () => Tres) {
  return (cond ? factory() : null) as (Tcond extends true ? Tres : null);
}
