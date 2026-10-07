"""Refuses to build a package without herceg's JavaScript bundles.

The bundles are build outputs (`npm run build:python`), not tracked by git;
a package built without them would install but fail to render.
"""

from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

BUNDLES = ("herceg.js", "herceg-static.js")


class BundleCheck(BuildHookInterface):
    PLUGIN_NAME = "custom"

    def initialize(self, version: str, build_data: dict) -> None:
        static = Path(self.root) / "src" / "herceg" / "static"
        missing = [name for name in BUNDLES if not (static / name).is_file()]
        if missing:
            raise RuntimeError(
                f"Missing {', '.join(missing)} in {static}. Run `npm run build:python` "
                "from the repository root before building the Python package."
            )
