"use client";

import { useState } from "react";
import { COMPARATOR_LABEL } from "@/lib/market";
import { useSource } from "@/lib/source";

const MAX_ORACLES = 5;

type Source = { url: string; jsonPath: string };

const STARTER: Source[] = [
  {
    url: "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
    jsonPath: ".ethereum.usd * 100 | floor",
  },
];

export function CreateMarketForm() {
  const source = useSource();

  const [question, setQuestion] = useState(
    "Will ETH be above $2,500 when this market resolves?",
  );
  const [sources, setSources] = useState<Source[]>(STARTER);
  const [quorum, setQuorum] = useState(1);
  const [target, setTarget] = useState("250000");
  const [comparator, setComparator] = useState(1);
  const [feeBps, setFeeBps] = useState(0);
  const [bettingSeconds, setBettingSeconds] = useState(60);
  const [resolveDelaySeconds, setResolveDelaySeconds] = useState(30);

  function editSource(index: number, patch: Partial<Source>) {
    setSources((current) =>
      current.map((source, i) => (i === index ? { ...source, ...patch } : source)),
    );
  }

  function submit() {
    return source.perform({
      type: "createMarket",
      params: {
        question,
        oracles: sources,
        quorum,
        target: BigInt(target || "0"),
        comparator,
        feeBps,
        bettingSeconds: BigInt(bettingSeconds),
        resolveDelaySeconds: BigInt(resolveDelaySeconds),
      },
    });
  }

  return (
    <section className="card">
      <h2>Ask a question</h2>
      <p className="muted" style={{ marginTop: "0.5rem" }}>
        Everything below is fixed the moment the market exists. There is no setter
        for any of it, and creating it books its own resolution in the same
        transaction.
      </p>

      <hr className="rule-divider" />

      <div className="stack" style={{ gap: "0.875rem" }}>
        <div className="field">
          <label className="label" htmlFor="question">
            Question
          </label>
          <textarea
            id="question"
            rows={2}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
          />
        </div>

        <fieldset>
          <legend>Oracles · {sources.length} of {MAX_ORACLES}</legend>
          <div className="stack" style={{ gap: "0.75rem" }}>
            {sources.map((source, index) => (
              <div key={index} className="stack" style={{ gap: "0.375rem" }}>
                <input
                  aria-label={`Source ${index + 1} url`}
                  className="mono"
                  value={source.url}
                  placeholder="https://…"
                  onChange={(event) => editSource(index, { url: event.target.value })}
                />
                <div className="row" style={{ gap: "0.5rem" }}>
                  <input
                    aria-label={`Source ${index + 1} jq program`}
                    className="mono"
                    value={source.jsonPath}
                    placeholder=".path | floor"
                    onChange={(event) =>
                      editSource(index, { jsonPath: event.target.value })
                    }
                  />
                  {sources.length > 1 && (
                    <button
                      className="against"
                      aria-label={`Remove source ${index + 1}`}
                      onClick={() =>
                        setSources((current) =>
                          current.filter((_, i) => i !== index),
                        )
                      }
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {sources.length < MAX_ORACLES && (
            <button
              style={{ marginTop: "0.75rem" }}
              onClick={() =>
                setSources((current) => [...current, { url: "", jsonPath: "" }])
              }
            >
              Add a source
            </button>
          )}

          <p className="muted" style={{ marginTop: "0.75rem", marginBottom: 0 }}>
            One source is read per scheduled wake-up — a short-running async
            precompile may be called once per transaction, so a quorum is gathered
            across executions rather than inside one.
          </p>
        </fieldset>

        <div className="grid-2">
          <div className="field">
            <label className="label" htmlFor="quorum">
              Readings required
            </label>
            <input
              id="quorum"
              inputMode="numeric"
              value={quorum}
              onChange={(event) => setQuorum(Number(event.target.value) || 1)}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="fee">
              Your cut (bps, max 500)
            </label>
            <input
              id="fee"
              inputMode="numeric"
              value={feeBps}
              onChange={(event) => setFeeBps(Number(event.target.value) || 0)}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="comparator">
              Resolves YES when the reading is
            </label>
            <select
              id="comparator"
              value={comparator}
              onChange={(event) => setComparator(Number(event.target.value))}
            >
              {COMPARATOR_LABEL.map((label, index) => (
                <option key={label} value={index}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="target">
              Target
            </label>
            <input
              id="target"
              inputMode="numeric"
              value={target}
              onChange={(event) => setTarget(event.target.value.replace(/\D/g, ""))}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="betting">
              Betting window (s, min 30)
            </label>
            <input
              id="betting"
              inputMode="numeric"
              value={bettingSeconds}
              onChange={(event) => setBettingSeconds(Number(event.target.value) || 0)}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="delay">
              Then resolve after (s, min 15)
            </label>
            <input
              id="delay"
              inputMode="numeric"
              value={resolveDelaySeconds}
              onChange={(event) =>
                setResolveDelaySeconds(Number(event.target.value) || 0)
              }
            />
          </div>
        </div>

        {source.error && <p className="notice bad">{source.error}</p>}

        <button
          className="primary"
          disabled={!source.isConnected || source.busy}
          onClick={submit}
        >
          {source.busy ? "Creating…" : "Create market"}
        </button>
      </div>
    </section>
  );
}
