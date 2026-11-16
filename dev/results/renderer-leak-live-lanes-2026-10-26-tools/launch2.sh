#!/bin/zsh
cd /private/tmp/claude-501/-Users-juanmnl-Developer-operator/b15ab04d-e9c2-43be-bcb2-39a423679c9a/scratchpad/wt/electron
export OPERATOR_DIR=/private/tmp/claude-501/-Users-juanmnl-Developer-operator/b15ab04d-e9c2-43be-bcb2-39a423679c9a/scratchpad/opdir2
export OPERATOR_CDP_PORT=9343
export ZDOTDIR=/private/tmp/claude-501/-Users-juanmnl-Developer-operator/b15ab04d-e9c2-43be-bcb2-39a423679c9a/scratchpad/zdot
echo $$ > /private/tmp/claude-501/-Users-juanmnl-Developer-operator/b15ab04d-e9c2-43be-bcb2-39a423679c9a/scratchpad/app.pid
exec /Users/juanmnl/Developer/operator/electron/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . --user-data-dir=/private/tmp/claude-501/-Users-juanmnl-Developer-operator/b15ab04d-e9c2-43be-bcb2-39a423679c9a/scratchpad/userdata2
