/** Probe the browser directly: a Herceg painter failure must still fail the tests. */
export function hasWebGL2(): boolean {
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = document.createElement("canvas").getContext("webgl2", { antialias: false });
  } catch {
    // Some browsers throw instead of returning null when context creation fails.
  }
  if (!gl) {
    console.warn("no WebGL2 in this browser");
    return false;
  }
  // Do not leave the probe counting toward the browser's context limit.
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return true;
}
