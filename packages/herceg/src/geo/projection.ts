// Map projections: longitude and latitude to plane coordinates, as d3-geo's
// raw projections compute them (radians in, units of the Earth's radius
// out, y pointing north). Only forward projections are needed: maps are
// drawn and picked in pixels.

/** Writes the plane position of longitude `lambda` and latitude `phi` (radians) to `out`. */
export type RawProjection = (lambda: number, phi: number, out: Float64Array) => void;

/** The latitude Mercator stops at, in degrees: where the map is as tall as it is wide. */
export const MERCATOR_LIMIT = (Math.atan(Math.sinh(Math.PI)) * 180) / Math.PI;

export const equirectangular: RawProjection = (lambda, phi, out) => {
  out[0] = lambda;
  out[1] = phi;
};

export const mercator: RawProjection = (lambda, phi, out) => {
  out[0] = lambda;
  out[1] = Math.log(Math.tan(Math.PI / 4 + phi / 2));
};

// Equal Earth (Šavrič, Patterson, and Jenny, 2018): equal-area, with
// straight parallels and meridians curving like the Robinson projection's.
const A1 = 1.340264;
const A2 = -0.081106;
const A3 = 0.000893;
const A4 = 0.003796;
const M = Math.sqrt(3) / 2;

export const equalEarth: RawProjection = (lambda, phi, out) => {
  const l = Math.asin(M * Math.sin(phi));
  const l2 = l * l;
  const l6 = l2 * l2 * l2;
  out[0] = (lambda * Math.cos(l)) / (M * (A1 + 3 * A2 * l2 + l6 * (7 * A3 + 9 * A4 * l2)));
  out[1] = l * (A1 + A2 * l2 + l6 * (A3 + A4 * l2));
};

// Natural Earth I (Šavrič, Jenny, Patterson, Petrovič, and Hurni, 2011):
// a compromise projection, as polynomials of latitude.
export const naturalEarth: RawProjection = (lambda, phi, out) => {
  const phi2 = phi * phi;
  const phi4 = phi2 * phi2;
  out[0] =
    lambda *
    (0.8707 - 0.131979 * phi2 + phi4 * (-0.013791 + phi4 * (0.003971 * phi2 - 0.001529 * phi4)));
  out[1] =
    phi * (1.007226 + phi2 * (0.015085 + phi4 * (-0.044475 + 0.028874 * phi2 - 0.005916 * phi4)));
};

/**
 * Albers' conic equal-area projection with standard parallels `phi0` and
 * `phi1` (radians). Parallels symmetric about the equator make it the
 * cylindrical equal-area projection, which it then is.
 */
export function albers(phi0: number, phi1: number): RawProjection {
  const sin0 = Math.sin(phi0);
  const n = (sin0 + Math.sin(phi1)) / 2;
  if (Math.abs(n) < 1e-6) {
    const cos0 = Math.cos(phi0);
    return (lambda, phi, out) => {
      out[0] = lambda * cos0;
      out[1] = Math.sin(phi) / cos0;
    };
  }
  const c = 1 + sin0 * (2 * n - sin0);
  const r0 = Math.sqrt(c) / n;
  return (lambda, phi, out) => {
    // At the pole away from the cone's apex, c - 2n sin(phi) can round below zero.
    const r = Math.sqrt(Math.max(0, c - 2 * n * Math.sin(phi))) / n;
    const angle = lambda * n;
    out[0] = r * Math.sin(angle);
    out[1] = r0 - r * Math.cos(angle);
  };
}
