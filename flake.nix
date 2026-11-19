{
  description = "Acro — HTTP workbench and future agent harness";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      eachSystem = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = eachSystem (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          # The window is the system webview, so the shell must provide WebKitGTK
          # as well as the GTK libraries it and mygo link against.
          linuxLibraries = with pkgs; [
            gtk3
            webkitgtk_4_1
            glib
            glib-networking
            libGL
            pango
            cairo
            harfbuzz
            fontconfig
            freetype
            libsoup_3
            json-glib
            libsecret
            libx11
            libxcomposite
            libxdamage
            libxext
            libxfixes
            libxrandr
            libxcursor
            libxi
            libgbm
            libxkbcommon
            expat
            libdrm
            alsa-lib
          ];
        in
        {
          default = pkgs.mkShell {
            packages =
              with pkgs;
              [
                go
                pkg-config
                just
                nixfmt
                nodejs
                bun
              ]
              ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux linuxLibraries;
            # Also build in a newly initialized repository without commits.
            GOFLAGS = "-buildvcs=false";
            LD_LIBRARY_PATH = pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux (
              pkgs.lib.makeLibraryPath linuxLibraries
            );
            GIO_EXTRA_MODULES = pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux "${pkgs.glib-networking}/lib/gio/modules";
            # WebKitGTK's sandbox needs its own helpers on the bus.
            WEBKIT_DISABLE_COMPOSITING_MODE = pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux "1";
          };
        }
      );
    };
}
