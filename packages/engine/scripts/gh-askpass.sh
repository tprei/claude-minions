#!/bin/sh

prompt=${1:-}

case "$prompt" in
  *Username*|*username*)
    printf '%s\n' "${GIT_USERNAME:-x-access-token}"
    ;;
  *Password*|*password*)
    if [ -n "${GH_TOKEN:-}" ]; then
      printf '%s\n' "$GH_TOKEN"
    else
      exit 1
    fi
    ;;
  *)
    if [ -n "${GH_TOKEN:-}" ]; then
      printf '%s\n' "$GH_TOKEN"
    else
      exit 1
    fi
    ;;
esac
