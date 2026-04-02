"use client";

import { useState } from "react";

export default function MethodologyPanel() {
  const [open, setOpen] = useState(false);

  return (
    <div className="methodology-panel">
      <button
        className="methodology-toggle"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        {open ? "▲ Hide methodology" : "▼ How it works"}
      </button>

      {open && (
        <div className="methodology-content">
          <section className="methodology-section">
            <h3 className="methodology-title">What this monitors</h3>
            <p className="methodology-body">
              The dashboard tracks the gap between two expressions of the same probability — the
              chance WTI crude oil settles above a given strike at daily expiry:
            </p>
            <ul className="methodology-list">
              <li>
                <strong className="explain-keyword">Kalshi</strong>: a binary event contract
                priced by market participants.
              </li>
              <li>
                <strong className="explain-keyword">BSM Fair Value</strong>: a call spread
                priced analytically using Black-Scholes with 90 IV, repriced in real time as the
                CME WTI front month (CL) moves.
              </li>
            </ul>
          </section>

          <section className="methodology-section">
            <h3 className="methodology-title">Why the gap exists</h3>
            <p className="methodology-body">
              The Kalshi price is driven by order flow, sentiment, and discrete liquidity. The
              call spread fair value moves smoothly as a function of the underlying. When Kalshi
              overreacts or underreacts relative to fair value, that&apos;s the dislocation.
            </p>
          </section>

          <section className="methodology-section">
            <h3 className="methodology-title">The delta comparison</h3>
            <p className="methodology-body">
              The scatter plot regression slopes measure{" "}
              <strong className="explain-keyword">implied delta</strong> — how many probability
              points each price moves per $1 in CL:
            </p>
            <ul className="methodology-list">
              <li>
                <strong className="explain-keyword">Kalshi delta</strong>: empirical, from
                regressing Kalshi price on CL price.
              </li>
              <li>
                <strong className="explain-keyword">Theoretical delta</strong>: analytical,
                from the BSM call spread.
              </li>
              <li>
                <strong className="explain-keyword">Delta ratio</strong>: if &lt; 1, Kalshi
                underreacts; if &gt; 1, Kalshi overreacts. A persistent ratio ≠ 1 is the edge
                signal.
              </li>
            </ul>
          </section>

          <section className="methodology-section">
            <h3 className="methodology-title">Practical application</h3>
            <p className="methodology-body">
              A trader could sell the Kalshi contract when it is rich relative to fair value and
              hedge with CL futures (or the call spread), or buy when cheap. The dashboard
              monitors when and how much that opportunity exists.
            </p>
          </section>

          <section className="methodology-section">
            <h3 className="methodology-title">Credit</h3>
            <p className="methodology-body">
              Inspired by{" "}
              <a
                className="methodology-link"
                href="https://moontower.substack.com/"
                rel="noreferrer"
                target="_blank"
              >
                Kris Abdelmessih&apos;s framework
              </a>{" "}
              — mapping binary event pricing to vanilla option spreads to identify cross-venue
              dislocations.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
