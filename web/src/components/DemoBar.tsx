"use client";

import { RECORDED } from "@/lib/demo";
import { useSource } from "@/lib/source";

/**
 * The demo says what it is, at the top of the page, before anything else.
 *
 * Nothing here is a transaction and nothing costs anything. What is real are the
 * readings: every number a market settles on was recorded from a live endpoint
 * and narrowed by the actual jq binary.
 */
export function DemoBar() {
  const source = useSource();
  if (source.mode !== "demo" || !source.demo) return null;

  const captured = RECORDED.length;

  return (
    <section
      className="card tight"
      style={{ borderColor: "rgba(250, 204, 21, 0.45)", marginBottom: "1.5rem" }}
      role="note"
      aria-label="Demo mode"
    >
      <div className="spread">
        <div>
          <span className="badge tone-gold">
            <span className="dot" aria-hidden />
            <span aria-hidden>◌</span>
            Demo — no chain
          </span>
          <p className="muted" style={{ margin: "0.6rem 0 0", maxWidth: "62ch" }}>
            Nothing on this page is a transaction and no money is involved. The
            rules are the contract&apos;s, run in your browser. The readings are
            real: {captured} responses recorded from live endpoints and narrowed by
            the jq binary, the same ones the contract&apos;s tests run against.
          </p>
        </div>

        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button onClick={() => source.demo!.advance(source.demo!.nextEvent)}>
            Skip to next event
          </button>
          <button onClick={() => source.demo!.advance(50n)}>+50 blocks</button>
          <button className="against" onClick={() => source.demo!.reset()}>
            Reset
          </button>
        </div>
      </div>

      {source.demo.log.length > 0 && (
        <div style={{ marginTop: "0.9rem" }} role="log" aria-live="polite">
          {source.demo.log.map((line, index) => (
            <p key={index} className="value" style={{ margin: "0.15rem 0" }}>
              <span style={{ color: "var(--gold)" }} aria-hidden>
                ⟳{" "}
              </span>
              {line}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
