interface ClosableDataChannel {
  isOpen(): boolean;
  close(): void;
}

interface ClosablePeerConnection {
  close(): void;
}

export interface RtcResources {
  dataChannel?: ClosableDataChannel | null;
  peerConnection?: ClosablePeerConnection | null;
  cleanup?: (() => void) | null;
}

export function closeRtcResources({
  dataChannel,
  peerConnection,
  cleanup,
}: RtcResources): void {
  try {
    if (dataChannel?.isOpen()) {
      dataChannel.close();
    }
  } catch {}

  try {
    peerConnection?.close();
  } catch {}

  try {
    cleanup?.();
  } catch {}
}
