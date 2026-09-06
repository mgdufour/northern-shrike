# Northern Shrike

A space domain awareness common operating picture — a browser-based dashboard for tracking satellites, stations, and debris using real TLE data propagated client-side with SGP4. Built with pure HTML, CSS, and JavaScript — no build tools or backend required.

## View it

**Live:** [https://mgdufour.github.io/northern-shrike/](https://mgdufour.github.io/northern-shrike/)

**Local:** Clone the repository and open `index.html` in any browser.

## Notes

- Orbit propagation runs entirely in the browser via [satellite.js](https://github.com/shashwatak/satellite.js).
- Tracked-object TLEs are embedded directly in the page — no live network calls or backend needed.
- The "Analyst Copilot" chat panel uses a Claude-specific capability (`window.claude.use`) that is only available when the page runs inside Claude's Artifact viewer. Outside that context it degrades gracefully — the map, catalog, and conjunction screening stay fully functional.
