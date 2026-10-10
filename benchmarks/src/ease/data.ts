// Data for the common-task samples. Every library's sample reads the same
// values from here, in the shape it takes most directly (columns of arrays or
// row objects, times as epoch milliseconds), so this setup is not counted in
// any sample's lines.

const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 1);

/** Daily request latency over 60 days: one array per column. */
export const days: number[] = Array.from({ length: 60 }, (_, i) => START + i * DAY);
export const p50: number[] = days.map((_, i) =>
  Math.round(120 + 25 * Math.sin(i / 5) + 8 * Math.sin(i * 1.7)),
);
export const p99: number[] = p50.map((value, i) => Math.round(value * 1.8 + 30 * Math.sin(i / 3)));
export const requests: number[] = days.map((_, i) =>
  Math.round(10_000 + 1_500 * Math.sin(i / 7) + ((i * 7_919) % 400)),
);

/** The same days as row objects. */
export const daily = days.map((time, i) => ({
  time,
  p50: p50[i]!,
  p99: p99[i]!,
  requests: requests[i]!,
}));

/** Latency of three services: a long table, one row per service and day. */
export const SERVICES = ["api", "web", "db"] as const;
export const serviceRows = SERVICES.flatMap((service, s) =>
  days.map((time, i) => ({
    time,
    service: service as string,
    latency: Math.round(80 + 40 * s + 20 * Math.sin(i / 4 + s)),
  })),
);
export const serviceColumns = {
  time: serviceRows.map((row) => row.time),
  service: serviceRows.map((row) => row.service),
  latency: serviceRows.map((row) => row.latency),
};

/** A latency objective and an incident window, for annotations. */
export const SLO = 250;
export const incident = { start: START + 20 * DAY, end: START + 24 * DAY, label: "Incident" };

/** A deterministic CPU reading every 100 ms, for streaming. */
export const STREAM_START = START;
export function reading(i: number): { time: number; cpu: number } {
  return {
    time: STREAM_START + i * 100,
    cpu: 0.5 + 0.3 * Math.sin(i / 20) + 0.1 * Math.sin(i * 1.3),
  };
}

/** A noisy signal of 100,000 points, one per second. */
export const BIG = 100_000;
export const bigTime = new Float64Array(BIG);
export const bigValue = new Float64Array(BIG);
{
  let seed = 7;
  for (let i = 0; i < BIG; i++) {
    seed = (seed * 48_271) % 2_147_483_647;
    bigTime[i] = START + i * 1_000;
    bigValue[i] = 40 * Math.sin(i / 4_000) + 10 * Math.sin(i / 300) + (seed / 2_147_483_647) * 12;
  }
}

/** Monthly revenue and its target, for bars and a line over categories. */
export const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun"];
export const revenue = [42, 58, 76, 64, 81, 90];
export const target = [50, 55, 60, 70, 75, 85];
export const monthly = months.map((month, i) => ({
  month,
  revenue: revenue[i]!,
  target: target[i]!,
}));
