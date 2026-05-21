import { io, type Socket } from 'socket.io-client';
import { SOCKET_EVENTS } from '@secscan/shared';

let socket: Socket | null = null;

function resolveSocketUrl(): string | undefined {
  const url = import.meta.env.VITE_SOCKET_URL?.trim();
  // Empty → same origin (nginx / Vite proxy on :3000 forwards /socket.io to API)
  return url ? url : undefined;
}

export function getSocket(): Socket {
  if (!socket) {
    socket = io(resolveSocketUrl(), { transports: ['websocket', 'polling'] });
  }
  return socket;
}

export { SOCKET_EVENTS };
