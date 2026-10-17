import { useRef } from "react";
import type { KikiState } from "../../shared/api.ts";

// Geometry and colours from assets/kiki.svg, which was measured from assets/kiki-approved.png.
const PINK = "#F59FAC";
const CHOC = "#3A2620";
const CREAM = "#FCF3E2";
const SILHOUETTE =
  "M1045 600C1047 646 1045 697 1029 740C1014 782 985 826 952 855C918 885 870 902 829 916C789 929 747 930 709 934C670 938 636 938 600 939C564 940 529 941 490 938C451 935 408 933 368 919C328 905 281 885 250 854C219 824 194 779 181 736C167 694 166 644 169 600C172 556 182 509 199 470C216 430 241 390 271 361C300 331 340 309 377 293C413 276 454 270 491 264C528 257 563 255 600 254C637 252 671 255 711 258C752 260 804 251 842 267C881 282 914 318 943 351C972 384 999 423 1016 465C1033 506 1043 554 1045 600Z";
const CLIP_LOOP = "M34 184V44A34 34 0 0 0 -34 44V214A34 34 0 0 0 34 214V198";
const CLIP_INNER = "M-6 80V168";
const CLIP_NOTCH = "M45 184A11 11 0 0 1 23 184";
const EYES = [
  { cx: 412, cy: 622 },
  { cx: 787, cy: 604 },
];

type EyeStyle = "oval" | "attentive" | "relaxed" | "happy";
type MouthStyle = "smile" | "soft" | "flat" | "short";

const MOUTHS: Record<MouthStyle, string> = {
  smile: "M585 710C612 711 640 700 668 666",
  soft: "M588 706C614 711 642 706 666 692",
  flat: "M596 702C618 704 640 704 660 701",
  short: "M612 701L648 700",
};

const FACES: Record<KikiState, { eyes: EyeStyle; mouth: MouthStyle }> = {
  idle: { eyes: "oval", mouth: "smile" },
  reading: { eyes: "oval", mouth: "soft" },
  searching: { eyes: "oval", mouth: "soft" },
  needs_you: { eyes: "attentive", mouth: "soft" },
  waiting: { eyes: "relaxed", mouth: "flat" },
  alert: { eyes: "attentive", mouth: "short" },
  done: { eyes: "happy", mouth: "smile" },
  error: { eyes: "oval", mouth: "flat" },
};

function Eye({ cx, cy, style }: { cx: number; cy: number; style: EyeStyle }) {
  if (style === "happy") {
    return <path d={`M${cx - 36} ${cy + 14}Q${cx} ${cy - 46} ${cx + 36} ${cy + 14}`} fill="none" stroke={CHOC} strokeWidth={22} strokeLinecap="round" />;
  }
  if (style === "attentive") return <ellipse cx={cx} cy={cy - 2} rx={41} ry={56} fill={CHOC} />;
  if (style === "relaxed") return <ellipse cx={cx} cy={cy + 6} rx={39} ry={42} fill={CHOC} />;
  return <ellipse cx={cx} cy={cy} rx={39} ry={52} fill={CHOC} />;
}

/**
 * Kiki. Decorative: the adjacent status text carries the meaning, so the SVG is hidden from
 * assistive tech. Entry motions play once when the state changes, never on a timer, and all
 * motion is disabled under prefers-reduced-motion (see styles.css).
 */
export function Kiki({ state, size = 160 }: { state: KikiState; size?: number }) {
  // Remount once per state change so an entry motion plays exactly once; not on first render.
  const previous = useRef<KikiState | null>(null);
  const generation = useRef(0);
  const changedThisSession = useRef(false);
  if (previous.current !== state) {
    if (previous.current !== null) {
      generation.current += 1;
      changedThisSession.current = true;
    }
    previous.current = state;
  }

  const face = FACES[state];
  const small = size < 96;
  const entry = changedThisSession.current ? (state === "done" ? "kiki--bob" : state === "needs_you" ? "kiki--tilt" : "") : "";
  const eyesClass = state === "idle" || state === "waiting" ? "kiki__eyes kiki__eyes--blink" : state === "searching" ? "kiki__eyes kiki__eyes--scan" : state === "reading" ? "kiki__eyes kiki__eyes--down" : "kiki__eyes";

  return (
    <svg
      key={generation.current}
      className={`kiki kiki--${state} ${entry}`}
      viewBox="148 218 920 740"
      width={size}
      height={Math.round((size * 740) / 920)}
      aria-hidden="true"
      focusable="false"
    >
      <g id="silhouette">
        <path fill={PINK} d={SILHOUETTE} />
      </g>
      <g className={eyesClass}>
        <g id="left-eye">
          <Eye {...EYES[0]!} style={face.eyes} />
        </g>
        <g id="right-eye">
          <Eye {...EYES[1]!} style={face.eyes} />
        </g>
      </g>
      <g id="mouth">
        <path d={MOUTHS[face.mouth]} fill="none" stroke={CHOC} strokeWidth={22} strokeLinecap="round" />
      </g>
      <g id="paperclip" transform="translate(895.7 344.4) rotate(-43.3) translate(0 -129)" fill="none" strokeLinecap="round" strokeLinejoin="round">
        {small ? (
          // At small sizes the outlined wire turns to mud; keep the loops, simplify the line weight.
          <>
            <path d={CLIP_LOOP} stroke={CHOC} strokeWidth={22} />
            <path d={CLIP_INNER} stroke={CHOC} strokeWidth={22} />
          </>
        ) : (
          <>
            <path d={CLIP_LOOP} stroke={CHOC} strokeWidth={28} />
            <path d={CLIP_LOOP} stroke={CREAM} strokeWidth={16} />
            <path d={CLIP_NOTCH} stroke={CHOC} strokeWidth={6} strokeLinecap="butt" />
            <path d={CLIP_INNER} stroke={CHOC} strokeWidth={28} />
            <path d={CLIP_INNER} stroke={CREAM} strokeWidth={16} />
          </>
        )}
      </g>
    </svg>
  );
}
