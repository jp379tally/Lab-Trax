{pkgs}: {
  deps = [
    pkgs.libgbm
    pkgs.xorg.xorgserver
    pkgs.alsa-lib
    pkgs.systemd
    pkgs.libxkbcommon
    pkgs.expat
    pkgs.mesa
    pkgs.xorg.libXrandr
    pkgs.xorg.libXfixes
    pkgs.xorg.libXdamage
    pkgs.xorg.libXcomposite
    pkgs.pango
    pkgs.gtk3
    pkgs.dbus
    pkgs.cups
    pkgs.at-spi2-core
    pkgs.at-spi2-atk
    pkgs.atk
    pkgs.poppler-utils
    pkgs.chromium
    pkgs.tmux
  ];
}
