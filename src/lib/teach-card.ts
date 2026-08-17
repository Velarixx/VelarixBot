/** ComputerPanel teach-card phases. Stop produces a draft; Save confirms. */
export type TeachCardPhase = "idle" | "recording" | "draft" | "saved";

export function teachPrimaryLabel(phase: TeachCardPhase): string | null {
  if (phase === "recording") return "Stop";
  if (phase === "idle" || phase === "saved") return "Start recording";
  return null;
}

export function teachShowsEditor(phase: TeachCardPhase): boolean {
  return phase === "draft" || phase === "saved";
}

export function teachShowsSaveDiscard(phase: TeachCardPhase): boolean {
  return phase === "draft";
}

export function teachCardPhase(input: { recording: boolean; hasDraft: boolean; hasSaved: boolean }): TeachCardPhase {
  if (input.recording) return "recording";
  if (input.hasDraft) return "draft";
  if (input.hasSaved) return "saved";
  return "idle";
}
