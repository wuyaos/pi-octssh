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

export function promisifyForwardOut(client: JumpClientLike, signal?: AbortSignal): ForwardOutFn {
  return (srcIP, srcPort, dstIP, dstPort) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        reject(signal?.reason ?? new Error("ProxyJump cancelled"));
      };
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        client.forwardOut(srcIP, srcPort, dstIP, dstPort, (err, stream) => {
          if (settled) {
            if (stream) stream.destroy();
            return;
          }
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          if (err) reject(err);
          else resolve(stream);
        });
      } catch (error) {
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      }
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
    if (err?.name === "AbortError" || err?.name === "TimeoutError") throw err;
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
  signal?: AbortSignal;
  connectTarget: (sock: Duplex) => Promise<T>;
}) {
  const forwardOut = promisifyForwardOut(params.jumpClient, params.signal);
  const sock = await openDirectTcpip({
    forwardOut,
    dstHost: params.targetHost,
    dstPort: params.targetPort,
  });
  try {
    params.signal?.throwIfAborted();
    return await params.connectTarget(sock);
  } catch (error) {
    sock.destroy();
    throw error;
  }
}
