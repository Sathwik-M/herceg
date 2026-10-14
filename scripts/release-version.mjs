export const packageFolders = ["herceg", "react", "vue", "svelte"];

export function isStableVersion(version) {
  return typeof version === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version);
}

// Match only the editable project, leaving registry packages and historical data alone.
export function editableHercegEntry(lock) {
  const entries = lock
    .split(/^\[\[package\]\]\s*$/m)
    .filter((entry) => /^name = "herceg"$/m.test(entry));
  if (entries.length !== 1 || !/^source = \{ editable = "\." \}$/m.test(entries[0])) {
    throw new Error("python/uv.lock: expected one editable herceg entry; regenerate the lockfile");
  }
  if (!/^version = "[^"]+"$/m.test(entries[0])) {
    throw new Error("python/uv.lock: editable herceg has no version; regenerate the lockfile");
  }
  return entries[0];
}
