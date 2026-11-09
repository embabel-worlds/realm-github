#!/bin/sh
# Ground-truth verification for realm-github's dev-vocabulary surface. Runs the ladder in tests/verify.py:
#   L0 GitHub itself   — the reference figures, computed from the REST API directly, with the
#                        producers' authorKind rule replicated in Python
#   L1 traversal       — kg execute over each door, exact equality with L0
#   L2 every view      — the fifteen vocabulary views, closed windows, every figure reconciled to the row
#   L3 the NL battery  — tests/questions.yml through the ask door, adversarial half x3
#   L6 forced failures — an unknown repository must be LOUD, an empty window must be quiet
# Exit nonzero on any drift. The Ship rate page's browser harness (L5) ships with the ship-rate realm.
#
#   GH_TOKEN=... EMBABEL_TOKEN=... APPLIANCE=http://127.0.0.1:11043 sh tests/verify.sh [owner/repo]
# (EMBABEL_AUTH=user:pass is accepted in place of EMBABEL_TOKEN.)
set -e
cd "$(dirname "$0")/.."
exec python3 tests/verify.py "$@"
