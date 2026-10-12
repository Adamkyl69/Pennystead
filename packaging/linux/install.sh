#!/bin/sh
# Installs Pennystead for the current user: ~/.local/share/pennystead-app + an applications-menu entry. No root needed.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
app="${XDG_DATA_HOME:-$HOME/.local/share}/pennystead-app"
menu="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$app" "$menu"
cp "$here/pennystead" "$app/pennystead"; chmod +x "$app/pennystead"
cp "$here/icon.png" "$app/icon.png"
sed -e "s|__EXEC__|$app/pennystead|" -e "s|__ICON__|$app/icon.png|" "$here/pennystead.desktop" > "$menu/pennystead.desktop"
echo "Pennystead installed. Find it in your applications menu, or run: $app/pennystead"
echo "To remove it: delete $app and $menu/pennystead.desktop (your data stays in ~/.local/share/pennystead)."
