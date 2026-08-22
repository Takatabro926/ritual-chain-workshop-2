import { PHASE_LABEL, PHASE_STYLE, type Phase } from "@/lib/market";

/**
 * Phase, as colour plus an icon plus a word. Never colour alone: about one in
 * twelve men cannot separate the green from the red.
 */
export function StateBadge({ phase }: { phase: Phase }) {
  const style = PHASE_STYLE[phase];
  return (
    <span
      className={`badge tone-${style.tone}`}
      role="status"
      aria-label={`Market status: ${PHASE_LABEL[phase]}`}
    >
      <span className={`dot${style.pulse ? " pulse" : ""}`} aria-hidden />
      <span aria-hidden>{style.icon}</span>
      {PHASE_LABEL[phase]}
    </span>
  );
}
