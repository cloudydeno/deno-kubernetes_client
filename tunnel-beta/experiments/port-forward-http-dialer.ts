// This "Dialer" class can be used by /x/socket_fetch

import { PortForwardTunnel } from "./run-port-forward.ts";

export class PortForwardDialer implements Dialer {
  constructor(
    private readonly tunnel: PortForwardTunnel,
    public readonly targetPort: number,
  ) {}

  async dial() {
    const socket = await this.tunnel.connectToPort(this.targetPort);

    socket.result.then(text => {
      console.error("Received error response:", text)
      // setTimeout( Deno.exit(5), 4000);
    });

    return socket.stream;
  }
}

type Conn = {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}
interface Dialer {
  dial(target: URL): Promise<Conn>;
}
