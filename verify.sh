#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root_dir="${ROOT_DIR:-$script_dir}"

tag_name="${TAG_NAME:-}"
input_version="${INPUT_VERSION:-}"

if [ -z "$tag_name" ] && [ "${GITHUB_EVENT_NAME:-}" = "workflow_dispatch" ] && [ "${GITHUB_REF_TYPE:-}" = "tag" ]; then
  tag_name="${GITHUB_REF_NAME:-}"
fi

if [ -n "$tag_name" ]; then
  base_version="$tag_name"
elif [ -n "$input_version" ]; then
  base_version="$input_version"
else
  file="$root_dir/plugin/gradle.properties"
  if [ ! -f "$file" ]; then
    echo "Version is required (release tag, workflow input, or missing $file)." >&2
    exit 1
  fi
  base_version="$(
    awk -F'=' '
      /^[[:space:]]*pluginVersion[[:space:]]*=/ {
        value=$2
        for (i=3; i<=NF; i++) value=value"="$i
        gsub(/\r/, "", value)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        gsub(/^"|"$/, "", value)
        gsub(/^'\''|'\''$/, "", value)
        print value
        exit
      }
    ' "$file"
  )"
  if [ -z "$base_version" ]; then
    echo "Version is required (release tag, workflow input, or plugin/gradle.properties)." >&2
    exit 1
  fi
fi

base_version="$(printf '%s' "$base_version" | tr -d '\r' | tr -d '\n' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
base_version="${base_version#v}"
if [ -z "$base_version" ]; then
  echo "Base version is required (release tag, workflow input, or plugin/gradle.properties)." >&2
  exit 1
fi

base_version_match="$(printf '%s' "$base_version" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)"
if [ -z "$base_version_match" ]; then
  printf "Base version must look like X.Y.Z, got: '%s'\n" "$base_version" >&2
  exit 1
fi

IFS='.' read -r major minor patch <<<"$base_version_match"

version="$major.$minor.$((patch + 1))"
echo "$version"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "version=$version" >> "$GITHUB_OUTPUT"
fi
