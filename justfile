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
