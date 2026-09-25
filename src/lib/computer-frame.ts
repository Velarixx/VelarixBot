export interface ComputerFrame { png: string; mime: string; at: number }
export const FRAME_STALE_MS = 6000;

export function freshFrame(frame: ComputerFrame | undefined | null, now: number): boolean {
  return Boolean(frame && now - frame.at < FRAME_STALE_MS);
}

export function newestFrame(...frames: Array<ComputerFrame | undefined | null>): ComputerFrame | null {
  return frames.reduce<ComputerFrame | null>((latest, frame) =>
    frame && (!latest || frame.at > latest.at) ? frame : latest, null);
}
