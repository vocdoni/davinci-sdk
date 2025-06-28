#!/bin/bash

DAVINCI_NODE_REPO="https://github.com/vocdoni/davinci-node"
DAVINCI_NODE_BRANCH="main"
DAVINCI_NODE_DIR="testenv"

[ ! -d "davinci-node" ] && {
  git clone --filter=blob:none --no-checkout $DAVINCI_NODE_REPO davinci-node
  cd davinci-node
  git sparse-checkout init --cone
  git sparse-checkout set $DAVINCI_NODE_DIR
  git checkout $DAVINCI_NODE_BRANCH
  cd ..
}

davinci-node/$DAVINCI_NODE_DIR/start.sh
