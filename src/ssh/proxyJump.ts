import type { Duplex } from "node:stream";

export type ForwardOutFn = (
  srcIP: string,
  srcPort: number,
  dstIP: string,
  dstPort: number
) => Promise<Duplex>;

export type JumpClientLike = {
  forwardOut: (
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    cb: (err: Error | undefined | null, stream: Duplex) => void
  ) => void;
};

export function promisifyForwardOut(client: JumpClientLike): ForwardOutFn {
  return (srcIP, srcPort, dstIP, dstPort) =>
    new Promise((resolve, reject) => {
      client.forwardOut(srcIP, srcPort, dstIP, dstPort, (err, stream) => {
        if (err) reject(err);
        else resolve(stream);
      });
    });
}

export async function openDirectTcpip(params: {
  forwardOut: ForwardOutFn;
  dstHost: string;
  dstPort: number;
}) {
  try {
    // srcIP/srcPort are mostly informational; 127.0.0.1:0 is a common choice.
    return await params.forwardOut("127.0.0.1", 0, params.dstHost, params.dstPort);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    // Helpful hint when admins disable TCP forwarding on jump host.
    const hint =
      msg.toLowerCase().includes("administratively prohibited") ||
      msg.toLowerCase().includes("tcp forwarding")
        ? " (possible cause: TCP forwarding disabled on jump host: AllowTcpForwarding=no)"
        : "";
    throw new Error(`ProxyJump forwardOut failed: ${msg}${hint}`);
  }
}

export async function connectViaProxyJump<T>(params: {
  jumpClient: JumpClientLike;
  targetHost: string;
  targetPort: number;
  connectTarget: (sock: Duplex) => Promise<T>;
}) {
  const forwardOut = promisifyForwardOut(params.jumpClient);
  const sock = await openDirectTcpip({
    forwardOut,
    dstHost: params.targetHost,
    dstPort: params.targetPort,
  });
  return params.connectTarget(sock);
}
