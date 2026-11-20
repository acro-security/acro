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
          gstPlugins = with pkgs.gst_all_1; [
            gst-plugins-base
            gst-plugins-good
            gst-plugins-bad
            gst-libav
          ];
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
                bitwarden-cli
              ]
              ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux (
                linuxLibraries
                ++ gstPlugins
                ++ [
                  pkgs.gst_all_1.gstreamer
                  pkgs.xdotool
                ]
              );
            # Also build in a newly initialized repository without commits.
            GOFLAGS = "-buildvcs=false";
            LD_LIBRARY_PATH = pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux (
              pkgs.lib.makeLibraryPath linuxLibraries
            );
            GIO_EXTRA_MODULES = pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux "${pkgs.glib-networking}/lib/gio/modules";
            # WebKit loads these at runtime, outside Nix's usual ELF library lookup.
            GST_PLUGIN_SYSTEM_PATH_1_0 = pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux (
              pkgs.lib.makeSearchPath "lib/gstreamer-1.0" gstPlugins
            );
            GST_PLUGIN_SCANNER_1_0 = pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux "${pkgs.gst_all_1.gstreamer.out}/libexec/gstreamer-1.0/gst-plugin-scanner";
            # Do not force WEBKIT_DISABLE_COMPOSITING_MODE here: it turns off
            # WebKit's accelerated compositing, so every scroll repaints the
            # page on the CPU and wheel/touchpad scrolling feels damped. The
            # guest browser pages need compositing; mygo already disables only
            # the DMABUF renderer, which is the part that breaks in sandboxes.
          };
        }
      );
    };
}
