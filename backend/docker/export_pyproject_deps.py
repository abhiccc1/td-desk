from __future__ import annotations

import argparse
from pathlib import Path
import tomllib


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export combined dependency lines from one or more pyproject.toml files."
    )
    parser.add_argument(
        "--group",
        action="append",
        default=[],
        help="Optional dependency group to include. Can be passed multiple times.",
    )
    parser.add_argument("--output", required=True, help="Requirements file to write.")
    parser.add_argument("pyprojects", nargs="+", help="pyproject.toml files to read.")
    return parser.parse_args()


def load_dependencies(pyproject_path: str, groups: list[str]) -> list[str]:
    data = tomllib.loads(Path(pyproject_path).read_text(encoding="utf-8"))
    project = data.get("project", {})
    dependencies = list(project.get("dependencies", []) or [])
    optional_dependencies = project.get("optional-dependencies", {}) or {}

    for group in groups:
        dependencies.extend(optional_dependencies.get(group, []) or [])

    return dependencies


def main() -> None:
    args = parse_args()

    merged: list[str] = []
    seen: set[str] = set()

    for pyproject_path in args.pyprojects:
        for dependency in load_dependencies(pyproject_path, args.group):
            requirement = dependency.strip()
            if requirement and requirement not in seen:
                seen.add(requirement)
                merged.append(requirement)

    output = "".join(f"{requirement}\n" for requirement in merged)
    Path(args.output).write_text(output, encoding="utf-8")


if __name__ == "__main__":
    main()

