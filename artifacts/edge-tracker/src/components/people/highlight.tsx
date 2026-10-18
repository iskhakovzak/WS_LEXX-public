import * as React from "react";
import { highlightSegments } from "@workspace/text-search";

/** Text with matched words emphasised (ranges from the people matcher). */
export function Highlight({ text, ranges }: { text: string; ranges?: readonly [number, number][] | null }) {
  if (!ranges?.length) return <>{text}</>;
  return (
    <>
      {highlightSegments(text, ranges).map((s, i) =>
        s.hit ? <mark key={i} className="rounded-[3px] bg-primary/20 px-px text-inherit">{s.text}</mark> : <React.Fragment key={i}>{s.text}</React.Fragment>,
      )}
    </>
  );
}
