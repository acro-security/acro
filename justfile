default:
    @just --list

install:
    bun install --frozen-lockfile
    go mod download

dev:
    go tool mygo dev

api:
    go run ./cmd/preview

check:
    bun run build:web
    bun run test:unit
    go test -race ./...
    go vet ./...

build:
    go tool mygo build

echo:
    go run ./cmd/echo

format:
    nixfmt flake.nix
    go fmt ./...
    bunx prettier --write src mygo.config.ts vite.config.ts tsconfig.json

format-check:
    nixfmt --check flake.nix
    @test -z "$(gofmt -l main.go internal cmd)"
    bunx prettier --check src mygo.config.ts vite.config.ts tsconfig.json

# Local-only Bitwarden-compatible vault; data survives container restarts.
vault-start:
    docker compose -f compose.vaultwarden.yml up -d

vault-stop:
    docker compose -f compose.vaultwarden.yml stop

# Build the native integration test; run it in your desktop or a virtual display.
test-browser-native:
    bun run build:web
    go build -tags browser_e2e -o /tmp/acro-browser-smoke ./cmd/browser-smoke
    /tmp/acro-browser-smoke
