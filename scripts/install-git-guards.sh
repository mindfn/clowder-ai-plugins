#!/bin/bash
# Install repo git guards (currently: pre-commit + pre-push).
# Idempotent. Run once per clone: pnpm guards:install
set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

chmod +x .githooks/pre-commit
chmod +x .githooks/pre-push
git config core.hooksPath .githooks

echo "git guards installed: core.hooksPath=.githooks"
echo "  pre-commit: refuses commits on mirror main (upstream-mirror clones only)"
echo "  pre-push: refuses pushes to any remote that is not the fork (mindfn/clowder-ai-plugins)"
