#!/bin/bash
# Double-clickable Finder launcher. All the logic lives in bin/epub-drop.
cd "$(dirname "$0")" || exit 1
exec ./bin/epub-drop start
